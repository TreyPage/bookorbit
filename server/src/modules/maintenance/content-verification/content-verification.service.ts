import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { RequestUser } from '../../common/types/request-user';
import { LibraryService } from '../library/library.service';
import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';
import { ContentVerificationAiService } from './content-verification-ai.service';
import { extractEpubContentEvidence } from './epub-content-evidence';
import { ContentVerificationRepository } from './content-verification.repository';

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

  async getResult(user: RequestUser, fileId: number) {
    const file = await this.getAccessibleFile(user, fileId);
    const result = await this.repository.findResultForFile(fileId);
    if (!result) return null;
    return { ...result, stale: result.fileHash !== file.fileHash };
  }

  async verifyFile(user: RequestUser, fileId: number) {
    const file = await this.getAccessibleFile(user, fileId);
    const title = file.title?.trim();
    if (!title) throw new BadRequestException('Book metadata must have a title before content can be verified');

    const extension = file.absolutePath.slice(file.absolutePath.lastIndexOf('.')).toLowerCase();
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
    const model = transcriptionModel ? `${transcriptionModel} + ${aiModel}` : aiModel;
    const result = await this.repository.saveResult({
      bookFileId: file.fileId,
      fileHash: file.fileHash,
      source,
      status: comparison.status,
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
