import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { access } from 'node:fs/promises';

import type { RequestUser } from '../../../common/types/request-user';
import { LibraryService } from '../../library/library.service';
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

  async list(user: RequestUser, page = 1, pageSize = 50, filter: 'all' | 'needs_review' | 'reviewed' | 'mismatch' = 'all') {
    const libraryIds = await this.libraryService.findAccessibleLibraryIds(user);
    const result = await this.repository.listCandidates(libraryIds, (page - 1) * pageSize, pageSize, filter);
    return { ...result, page, pageSize, totalPages: Math.max(1, Math.ceil(result.total / pageSize)) };
  }

  async getResult(user: RequestUser, fileId: number) {
    const file = await this.getAccessibleFile(user, fileId);
    const result = await this.repository.findResultForFile(fileId);
    if (!result) return null;
    return { ...result, stale: result.fileHash !== file.fileHash };
  }

  async reviewFile(user: RequestUser, fileId: number, reviewStatus: 'confirmed_mismatch' | 'false_positive' | 'needs_recheck', reviewNote?: string) {
    const file = await this.getAccessibleFile(user, fileId);
    const existing = await this.repository.findResultForFile(fileId);
    if (!existing) throw new NotFoundException('Content verification result not found');
    if (reviewStatus !== 'needs_recheck' && !['mismatch', 'inconclusive'].includes(existing.status)) {
      throw new BadRequestException('Only mismatch or inconclusive AI results can be confirmed or marked as false positives');
    }
    const result = await this.repository.updateReview(fileId, {
      reviewStatus,
      reviewNote: reviewNote?.trim() || null,
      reviewedBy: user.id,
      reviewedAt: new Date(),
    });
    if (!result) throw new NotFoundException('Content verification result not found');
    return { ...result, stale: result.fileHash !== file.fileHash };
  }


  async previewCorrection(
    user: RequestUser,
    fileId: number,
    input: { targetType: 'existing_book' | 'new_book'; targetBookId?: number; title?: string; author?: string },
  ) {
    const libraryIds = await this.libraryService.findEditableLibraryIds(user);
    const context = await this.repository.findCorrectionContext(fileId, libraryIds, input.targetBookId);
    if (!context) throw new NotFoundException('Book file not found or not editable');
    const { source, contentFileCount, audioContentCount, target, targetFormatCount } = context;

    if (source.role !== 'content') throw new BadRequestException('Only ebook or audiobook content files can be corrected');
    if (source.reviewStatus !== 'confirmed_mismatch') {
      throw new BadRequestException('Confirm the content mismatch before preparing a file correction');
    }
    if (!source.fileHash || source.verificationFileHash !== source.fileHash) {
      throw new BadRequestException('The verification result is stale; verify the current file again before correcting it');
    }
    const supported = new Set(['epub', 'm4b', 'm4a', 'mp3', 'aac', 'flac', 'ogg', 'opus', 'wav']);
    const extension = extname(source.absolutePath).toLowerCase();
    if (!supported.has(extension.slice(1))) throw new BadRequestException('File correction currently supports EPUB and audiobook formats');
    if (contentFileCount < 2) throw new BadRequestException('This is the only content file in the book; use the book move workflow instead');
    if (audioContentCount > 1 && ['.m4b', '.m4a', '.mp3', '.aac', '.flac', '.ogg', '.opus', '.wav'].includes(extension)) {
      throw new BadRequestException('This audiobook has multiple audio parts. Multipart audiobooks must be corrected as a complete unit');
    }

    let destinationBookId: number | null = null;
    let destinationFolderPath: string;
    let destinationPath: string;
    let destinationTitle: string;

    if (input.targetType === 'existing_book') {
      if (!input.targetBookId || !target) throw new BadRequestException('Choose an existing destination book');
      if (target.bookId === source.bookId) throw new BadRequestException('The destination must be a different book');
      if (target.libraryId !== source.libraryId || target.libraryFolderId !== source.libraryFolderId) {
        throw new BadRequestException('A file can only be moved to another book in the same library folder');
      }
      if (source.organizationMode !== 'book_per_folder') {
        throw new BadRequestException('Joining another book is supported only in folder-organized libraries');
      }
      if (targetFormatCount > 0) throw new BadRequestException('The destination book already contains this format');
      destinationBookId = target.bookId;
      destinationFolderPath = target.folderPath;
      destinationPath = join(destinationFolderPath, basename(source.absolutePath));
      destinationTitle = target.title ?? 'Untitled book';
    } else {
      const title = input.title?.trim();
      const author = input.author?.trim();
      if (!title || !author) throw new BadRequestException('Provide the detected book title and author');
      const safeSegment = (value: string) =>
        value.normalize('NFKC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 160) || 'Untitled';
      const stem = safeSegment(title);
      const authorSegment = safeSegment(author);
      if (source.organizationMode === 'book_per_folder') {
        destinationFolderPath = join(dirname(source.bookFolderPath), `${stem} - ${authorSegment}`);
        destinationPath = join(destinationFolderPath, `${stem}${extension}`);
      } else {
        destinationPath = join(dirname(source.absolutePath), `${stem} - ${authorSegment}${extension}`);
        destinationFolderPath = destinationPath;
      }
      destinationTitle = title;
    }

    const root = resolve(source.libraryFolderPath);
    const destination = resolve(destinationPath);
    const folder = resolve(destinationFolderPath);
    const relativeDestination = relative(root, destination);
    if (relativeDestination.startsWith('..') || isAbsolute(relativeDestination) || folder !== root && !folder.startsWith(root + '/') && !folder.startsWith(root + '\\\\')) {
      throw new BadRequestException('The proposed destination is outside the library folder');
    }

    try {
      await access(destination);
      throw new BadRequestException('The proposed destination file already exists');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (input.targetType === 'new_book' && source.organizationMode === 'book_per_folder') {
      try {
        await access(destinationFolderPath);
        throw new BadRequestException('A folder with the proposed book name already exists');
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    return {
      fileId,
      sourceBookId: source.bookId,
      sourceBookTitle: source.title,
      sourcePath: source.absolutePath,
      destinationType: input.targetType,
      destinationBookId,
      destinationTitle,
      destinationFolderPath,
      destinationPath,
      fileFormat: source.format,
      verificationStatus: source.verificationStatus,
      reviewStatus: source.reviewStatus,
      requiresApproval: true,
      executionAvailable: false,
    };
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
