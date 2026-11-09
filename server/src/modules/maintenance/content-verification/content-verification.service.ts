import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { extname } from 'node:path';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';
import { ContentVerificationAiService } from './content-verification-ai.service';
import { extractEpubContentEvidence } from './epub-content-evidence';
import { ContentVerificationRepository } from './content-verification.repository';

const MIN_VERIFICATION_CONFIDENCE = 0.85;
const AUDIO_EXTENSIONS = new Set(['.m4b', '.m4a', '.mp3', '.aac', '.flac', '.ogg', '.opus', '.wav']);

@Injectable()
export class ContentVerificationService {
  constructor(
    private readonly repository: ContentVerificationRepository,
    private readonly libraryService: LibraryService,
    private readonly ai: ContentVerificationAiService,
    private readonly transcription: AudiobookOpeningTranscriptionService,
    private readonly config: ConfigService,
  ) {}

  isAiConfigured(): boolean {
    return this.ai.isConfigured();
  }

  isTranscriptionConfigured(): boolean {
    return this.transcription.isConfigured();
  }

  async verifyFileForSystem(fileId: number) {
    const user = { id: 0, isSuperuser: true } as RequestUser;
    return this.verifyFile(user, fileId);
  }

  async list(user: RequestUser, page = 1, pageSize = 50) {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const result = await this.repository.listCandidates(libraryIds, (page - 1) * pageSize, pageSize);
    return { ...result, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) };
  }

  async getResult(user: RequestUser, fileId: number) {
    const file = await this.getAccessibleFile(user, fileId);
    const result = await this.repository.findResultForFile(fileId);
    if (!result) return null;
    return { ...result, stale: result.fileHash !== file.fileHash };
  }

  async reviewFile(
    user: RequestUser,
    fileId: number,
    reviewStatus: 'confirmed_mismatch' | 'false_positive' | 'needs_recheck',
    reviewNote?: string,
  ) {
    await this.getAccessibleFile(user, fileId);
    const existing = await this.repository.findResultForFile(fileId);
    if (!existing) throw new NotFoundException('Content verification result not found');
    const result = await this.repository.updateReview(fileId, {
      reviewStatus,
      reviewNote: reviewNote?.trim() || null,
      reviewedBy: user.id,
      reviewedAt: new Date(),
    });
    return { ...result, stale: result?.fileHash !== existing.fileHash };
  }

  async verifyFile(user: RequestUser, fileId: number) {
    const file = await this.getAccessibleFile(user, fileId);
    const title = file.title?.trim();
    if (!title) throw new BadRequestException('Book metadata must have a title before content can be verified');

    const extension = extname(file.absolutePath).toLowerCase();
    let source: 'ebook' | 'audiobook';
    let evidence: Array<{ label: string; text: string }>;
    let transcriptionModel: string | null = null;

    if (extension === '.epub') {
      source = 'ebook';
      const inspection = await extractEpubContentEvidence(file.absolutePath);
      evidence = inspection.documents.map((document) => ({
        label: document.likelyTitlePage ? `Likely title page: ${document.path}` : document.path,
        text: document.text,
      }));
      if (evidence.length === 0) throw new BadRequestException('No readable XHTML content was found in this EPUB');
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      source = 'audiobook';
      const transcript = await this.transcription.transcribe(file.absolutePath);
      transcriptionModel = transcript.model;
      evidence = [{ label: `Opening audio transcript (${transcript.sampleSeconds} seconds)`, text: transcript.transcript }];
    } else {
      throw new BadRequestException('Content verification supports EPUB ebooks and common audiobook formats');
    }

    const comparison = await this.ai.compare({
      expectedTitle: title,
      expectedAuthors: file.authors,
      source,
      evidence,
    });
    const aiModel = this.config.get<string>('contentVerification.aiModel') || 'qwen3.5:4b';
    const status = comparison.confidence < MIN_VERIFICATION_CONFIDENCE || !comparison.detectedTitle ? 'inconclusive' : comparison.status;
    const model = transcriptionModel ? `${transcriptionModel} + ${aiModel}` : aiModel;
    const result = await this.repository.saveResult({
      bookFileId: file.fileId,
      fileHash: file.fileHash,
      source,
      status,
      expectedTitle: title,
      expectedAuthors: file.authors,
      detectedTitle: comparison.detectedTitle,
      detectedAuthor: comparison.detectedAuthor,
      confidence: comparison.confidence,
      evidence,
      explanation: comparison.explanation,
      model,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    });

    return { ...result, stale: false };
  }

  private async getAccessibleFile(user: RequestUser, fileId: number) {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const file = await this.repository.findFileForVerification(fileId, libraryIds);
    if (!file) throw new NotFoundException('Book file not found or not accessible');
    return file;
  }
}
