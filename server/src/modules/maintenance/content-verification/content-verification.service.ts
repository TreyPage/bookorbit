import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, link, mkdir, realpath, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { RequestUser } from '../../../common/types/request-user';
import { FileLockService, bookOperationLockKey } from '../../../common/services/file-lock.service';
import { SelfWriteRegistry } from '../../../common/services/self-write-registry.service';
import { computeFileHash } from '../../../common/utils/file-hash.utils';
import { FileWriteService } from '../../file-write/file-write.service';
import { LibraryService } from '../../library/library.service';
import { AudiobookOpeningTranscriptionService } from './audiobook-opening-transcription.service';
import { ContentVerificationAiService } from './content-verification-ai.service';
import { extractEpubContentEvidence } from './epub-content-evidence';
import { ContentVerificationRepository } from './content-verification.repository';

const MIN_VERIFICATION_CONFIDENCE = 0.85;
const AUDIO_EXTENSIONS = new Set(['.m4b', '.m4a', '.mp3', '.aac', '.flac', '.ogg', '.opus', '.wav']);

@Injectable()
export class ContentVerificationService {
  /** Serializes verification globally so STT and comparison never overlap. */
  private verificationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly repository: ContentVerificationRepository,
    private readonly libraryService: LibraryService,
    private readonly ai: ContentVerificationAiService,
    private readonly transcription: AudiobookOpeningTranscriptionService,
    private readonly config: ConfigService,
    private readonly fileLock: FileLockService,
    private readonly selfWriteRegistry: SelfWriteRegistry,
    private readonly fileWriteService: FileWriteService,
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
    return this.fileLock.withLock(`content-verification-file:${fileId}`, async () => {
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
    });
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
    if (contentFileCount < 2) throw new BadRequestException('A file-level split requires another content file to remain in the original book');
    if (audioContentCount > 1 && ['.m4b', '.m4a', '.mp3', '.aac', '.flac', '.ogg', '.opus', '.wav'].includes(extension)) {
      throw new BadRequestException('This audiobook has multiple audio parts. Multipart audiobooks must be corrected as a complete unit');
    }

    const safeSegment = (value: string, maxBytes = 180) => {
      const normalized = value
        .normalize('NFKC')
        .replace(/[/:*?"<>|]/g, '-')
        .replace(/\\/g, '-')
        .replace(/\p{Cc}/gu, '-')
        .replace(/[. ]+$/g, '')
        .trim();

      let sanitized = '';
      for (const character of normalized) {
        if (Buffer.byteLength(sanitized + character, 'utf8') > maxBytes) break;
        sanitized += character;
      }
      return sanitized.trim() || 'Untitled';
    };
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
      destinationFolderPath = target.destinationFolderPath;
      const targetStem = target.title?.trim() ? safeSegment(target.title) : basename(source.absolutePath, extension);
      destinationPath = join(destinationFolderPath, `${targetStem}${extension}`);
      destinationTitle = target.title ?? 'Untitled book';
    } else {
      const title = input.title?.trim();
      const author = input.author?.trim();
      if (!title || !author) throw new BadRequestException('Provide the detected book title and author');
      const stem = safeSegment(title);
      const authorSegment = safeSegment(author, 120);
      const combinedSegment = safeSegment(`${stem} - ${authorSegment}`, 240);
      if (source.organizationMode === 'book_per_folder') {
        destinationFolderPath = join(dirname(source.bookFolderPath), combinedSegment);
        destinationPath = join(destinationFolderPath, `${stem}${extension}`);
      } else {
        destinationPath = join(dirname(source.absolutePath), `${combinedSegment}${extension}`);
        destinationFolderPath = destinationPath;
      }
      destinationTitle = title;
    }

    const root = resolve(source.libraryFolderPath);
    const destination = resolve(destinationPath);
    const folder = resolve(destinationFolderPath);
    const isWithinLibrary = (candidate: string) => {
      const relativePath = relative(root, candidate);
      return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
    };
    if (!isWithinLibrary(destination) || !isWithinLibrary(folder)) {
      throw new BadRequestException('The proposed destination is outside the library folder');
    }

    if (destination !== resolve(source.absolutePath)) {
      try {
        await access(destination);
        throw new BadRequestException('The proposed destination file already exists');
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    if (input.targetType === 'existing_book') {
      try {
        await access(destinationFolderPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new BadRequestException('The destination book folder is not available on disk');
        }
        throw error;
      }
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

    if (input.targetType === 'new_book' && (await this.repository.isBookFolderPathTaken(source.libraryId, destinationFolderPath))) {
      throw new BadRequestException('A book record already uses the proposed destination path');
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
      fileFormat: source.format || extension.slice(1).toLowerCase(),
      verificationStatus: source.verificationStatus,
      reviewStatus: source.reviewStatus,
      requiresApproval: true,
      executionAvailable: true,
    };
  }

  async searchCorrectionTargets(user: RequestUser, fileId: number, query = '') {
    const libraryIds = await this.libraryService.findEditableLibraryIds(user);
    const targets = await this.repository.findCorrectionTargets(fileId, libraryIds, query.slice(0, 200));
    if (!targets) throw new NotFoundException('Book file not found or not editable');
    return targets;
  }

  async executeCorrection(
    user: RequestUser,
    fileId: number,
    input: { targetType: 'existing_book' | 'new_book'; targetBookId?: number; title?: string; author?: string },
  ) {
    const initialPreview = await this.previewCorrection(user, fileId, input);
    const lockBookIds = [initialPreview.sourceBookId, ...(initialPreview.destinationBookId ? [initialPreview.destinationBookId] : [])];
    const lockKeys = [...new Set(lockBookIds)].sort((a, b) => a - b).map(bookOperationLockKey);
    const pathLockKeys = [...new Set([initialPreview.sourcePath, initialPreview.destinationPath])].sort();
    const withPathLocks = async <T>(index: number, operation: () => Promise<T>): Promise<T> => {
      if (index >= pathLockKeys.length) return operation();
      return this.fileLock.withLock(pathLockKeys[index], () => withPathLocks(index + 1, operation));
    };
    const withBookLocks = async <T>(index: number, operation: () => Promise<T>): Promise<T> => {
      if (index >= lockKeys.length) return operation();
      return this.fileLock.withLock(lockKeys[index], () => withBookLocks(index + 1, operation));
    };

    const correctionResult = await withBookLocks(0, () =>
      withPathLocks(0, () =>
        this.fileLock.withLock(`content-verification-file:${fileId}`, async () => {
          const preview = await this.previewCorrection(user, fileId, input);
          if (preview.sourceBookId !== initialPreview.sourceBookId || preview.destinationPath !== initialPreview.destinationPath) {
            throw new BadRequestException('The source book changed while preparing this correction; preview it again');
          }
          const libraryIds = await this.libraryService.findEditableLibraryIds(user);
          const context = await this.repository.findCorrectionContext(fileId, libraryIds, input.targetBookId);
          if (!context || context.source.absolutePath !== preview.sourcePath) {
            throw new BadRequestException('The source file changed while preparing this correction; preview it again');
          }
          const rootRealPath = await realpath(context.source.libraryFolderPath);
          const sourceRealPath = await realpath(preview.sourcePath);
          const destinationParentPath =
            input.targetType === 'new_book' && context.source.organizationMode === 'book_per_folder'
              ? dirname(preview.destinationFolderPath)
              : dirname(preview.destinationPath);
          const destinationParentRealPath = await realpath(destinationParentPath);
          const isInsideLibrary = (candidate: string) => {
            const relativePath = relative(rootRealPath, candidate);
            return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
          };
          if (!isInsideLibrary(sourceRealPath) || !isInsideLibrary(destinationParentRealPath)) {
            throw new BadRequestException('The source or destination resolves outside the library folder');
          }
          const sourceHash = await computeFileHash(preview.sourcePath);
          if (sourceHash !== context.source.fileHash || sourceHash !== context.source.verificationFileHash) {
            throw new BadRequestException('The source file changed after verification; run content verification again');
          }

          const sourcePath = preview.sourcePath;
          const destinationPath = preview.destinationPath;
          const samePath = resolve(sourcePath) === resolve(destinationPath);
          const stagingPath = samePath ? null : join(dirname(destinationPath), `.bookorbit-correction-${fileId}-${randomUUID()}.tmp`);
          const watchedPaths = [sourcePath, destinationPath, ...(stagingPath ? [stagingPath] : []), dirname(sourcePath), dirname(destinationPath)];
          return this.selfWriteRegistry.track(watchedPaths, async () => {
            let createdDestinationFolder = false;
            if (samePath) {
              // The file is already named and located correctly; only its book association changes.
            } else if (input.targetType === 'new_book' && context.source.organizationMode === 'book_per_folder') {
              await mkdir(preview.destinationFolderPath);
              createdDestinationFolder = true;
            } else {
              await mkdir(dirname(destinationPath), { recursive: true });
            }
            let stagingCreated = false;
            let destinationCreated = false;
            let databaseCommitted = false;
            let preserveStagedFile = false;
            const fallbackLinkErrors = new Set(['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP']);

            try {
              if (!samePath && stagingPath) {
                try {
                  await link(sourcePath, stagingPath);
                  stagingCreated = true;
                } catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  if (!code || !fallbackLinkErrors.has(code)) throw error;
                  await copyFile(sourcePath, stagingPath, fsConstants.COPYFILE_EXCL);
                  stagingCreated = true;
                }

                const stagedHash = await computeFileHash(stagingPath);
                if (stagedHash !== sourceHash) throw new Error('The staged file did not retain its verified content hash');

                try {
                  await link(stagingPath, destinationPath);
                  destinationCreated = true;
                } catch (error) {
                  const code = (error as NodeJS.ErrnoException).code;
                  if (!code || !fallbackLinkErrors.has(code)) throw error;
                  await copyFile(stagingPath, destinationPath, fsConstants.COPYFILE_EXCL);
                  destinationCreated = true;
                }

                await unlink(stagingPath);
                stagingCreated = false;
              }

              const destinationStats = await stat(destinationPath, { bigint: true });
              const destinationHash = await computeFileHash(destinationPath);
              if (destinationHash !== sourceHash) throw new Error('The moved file did not retain its verified content hash');

              let result: {
                fileId: number;
                sourceBookId: number;
                destinationBookId: number;
                targetType: 'existing_book' | 'new_book';
              };
              try {
                result = await this.repository.applyFileCorrection({
                  fileId,
                  sourceBookId: preview.sourceBookId,
                  targetBookId: preview.destinationBookId ?? undefined,
                  targetType: input.targetType,
                  destinationPath,
                  destinationFolderPath: preview.destinationFolderPath,
                  targetBookFolderPath: context.target?.folderPath,
                  destinationRelPath: relative(context.source.libraryFolderPath, destinationPath),
                  sourcePath,
                  sourceHash,
                  format: preview.fileFormat,
                  reviewedBy: user.id,
                  fileStats: {
                    ino: destinationStats.ino,
                    sizeBytes: Number(destinationStats.size),
                    mtime: destinationStats.mtime,
                  },
                  title: input.title,
                  author: input.author,
                });
                databaseCommitted = true;
              } catch (databaseError) {
                let persistedLocation: Awaited<ReturnType<ContentVerificationRepository['findCorrectionFileLocation']>>;
                try {
                  persistedLocation = await this.repository.findCorrectionFileLocation(fileId);
                } catch {
                  preserveStagedFile = true;
                  throw new Error(
                    'The database outcome is uncertain. Both the original file "' +
                      sourcePath +
                      '" and staged file "' +
                      destinationPath +
                      '" have been retained for safety.',
                    { cause: databaseError },
                  );
                }

                const persistedAtDestination = Boolean(
                  persistedLocation &&
                  persistedLocation.absolutePath === destinationPath &&
                  (input.targetType === 'new_book'
                    ? persistedLocation.bookId !== preview.sourceBookId
                    : persistedLocation.bookId === preview.destinationBookId),
                );
                if (persistedAtDestination) {
                  databaseCommitted = true;
                  result = {
                    fileId,
                    sourceBookId: preview.sourceBookId,
                    destinationBookId: persistedLocation.bookId,
                    targetType: input.targetType,
                  };
                } else if (persistedLocation && persistedLocation.absolutePath === sourcePath && persistedLocation.bookId === preview.sourceBookId) {
                  throw databaseError;
                } else {
                  preserveStagedFile = true;
                  throw new Error(
                    'The database outcome is uncertain. Both the original file "' +
                      sourcePath +
                      '" and staged file "' +
                      destinationPath +
                      '" have been retained for safety.',
                    { cause: databaseError },
                  );
                }
              }

              let sourceCleanupPending = false;
              if (!samePath) {
                try {
                  await unlink(sourcePath);
                } catch (cleanupError) {
                  if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') sourceCleanupPending = true;
                }
              }

              return {
                ...result,
                previousPath: sourcePath,
                currentPath: destinationPath,
                verificationEvidencePreserved: true,
                verificationRequiresRecheck: true,
                sourceCleanupPending,
                requiresRescan: false,
              };
            } catch (error) {
              if (!databaseCommitted && !preserveStagedFile && stagingCreated && stagingPath) {
                try {
                  await unlink(stagingPath);
                } catch (cleanupError) {
                  if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') preserveStagedFile = true;
                }
              }
              if (destinationCreated && !databaseCommitted && !preserveStagedFile) {
                try {
                  await unlink(destinationPath);
                } catch (cleanupError) {
                  if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
                    preserveStagedFile = true;
                  }
                }
              }
              if (createdDestinationFolder && !preserveStagedFile) {
                await rmdir(preview.destinationFolderPath).catch(() => undefined);
              }
              if (preserveStagedFile) {
                throw new Error(
                  'Correction did not complete cleanly. The original file remains at "' +
                    sourcePath +
                    '" and a temporary or destination file may remain. Inspect the destination folder before retrying.',
                  { cause: error },
                );
              }
              throw error;
            }
          });
        }),
      ),
    );

    // The file has been reassigned and the book locks are released. Write only this corrected
    // format using the destination book's metadata; never rewrite the destination's sibling files.
    let embeddedMetadataWrite: Awaited<ReturnType<FileWriteService['writeMetadataToFile']>>;
    try {
      embeddedMetadataWrite = await this.fileWriteService.writeMetadataToFile(correctionResult.destinationBookId, fileId, user.id);
    } catch (error) {
      embeddedMetadataWrite = {
        status: 'failed',
        fieldsWritten: [],
        durationMs: 0,
        reason: error instanceof Error ? error.message : 'embedded metadata write failed',
      };
    }

    return { ...correctionResult, embeddedMetadataWrite };
  }

  /**
   * Verify a staged Book Dock unit without importing it or persisting a library verification row.
   * For multipart audiobooks, sample the first two content parts so the check identifies the
   * release as a whole without transcribing every chapter in a large unit.
   */
  async verifyStagedContent(input: { title: string; authors: string[]; files: Array<{ path: string; format: string; label: string }> }) {
    const title = input.title.trim();
    if (!title) throw new BadRequestException('Book Dock metadata must have a title before content can be verified');
    const files = input.files.filter((file) => file.path && file.format).slice(0, 2);
    if (files.length === 0) throw new BadRequestException('No supported content files were found in this Book Dock entry');

    const firstExtension = extname(files[0]!.path).toLowerCase();
    let source: 'ebook' | 'audiobook';
    let evidence: Array<{ label: string; text: string }> = [];
    const transcriptionModels: string[] = [];

    if (firstExtension === '.epub') {
      source = 'ebook';
      const inspection = await extractEpubContentEvidence(files[0]!.path);
      evidence = inspection.documents.map((document) => ({
        label: document.likelyTitlePage ? `Likely title page: ${document.path}` : document.path,
        text: document.text,
      }));
      if (evidence.length === 0) throw new BadRequestException('No readable XHTML content was found in this EPUB');
    } else if (files.every((file) => AUDIO_EXTENSIONS.has(extname(file.path).toLowerCase()))) {
      source = 'audiobook';
      for (const file of files) {
        const transcript = await this.transcription.transcribe(file.path);
        transcriptionModels.push(transcript.model);
        evidence.push({ label: `Opening audio transcript: ${file.label} (${transcript.sampleSeconds} seconds)`, text: transcript.transcript });
      }
    } else {
      throw new BadRequestException('Pre-import content verification supports EPUB ebooks and common audiobook formats');
    }

    const comparison = await this.ai.compare({ expectedTitle: title, expectedAuthors: input.authors, source, evidence });
    const aiModel = this.config.get<string>('contentVerification.aiModel') || 'qwen3.5:4b';
    return {
      status: comparison.confidence < MIN_VERIFICATION_CONFIDENCE || !comparison.detectedTitle ? 'inconclusive' : comparison.status,
      source,
      expectedTitle: title,
      expectedAuthors: input.authors,
      detectedTitle: comparison.detectedTitle,
      detectedAuthor: comparison.detectedAuthor,
      confidence: comparison.confidence,
      explanation: comparison.explanation,
      evidence,
      model: [...new Set(transcriptionModels)].concat(aiModel).join(' + '),
      verifiedAt: new Date().toISOString(),
      persisted: false,
    };
  }

  async verifyFile(user: RequestUser, fileId: number) {
    const previous = this.verificationTail;
    let release!: () => void;
    this.verificationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.fileLock.withLock(`content-verification-file:${fileId}`, () => this.verifyFileUnlocked(user, fileId));
    } finally {
      release();
    }
  }

  private async verifyFileUnlocked(user: RequestUser, fileId: number) {
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
