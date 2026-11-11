vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  realpath: vi.fn(),
  rmdir: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('../../../common/utils/file-hash.utils', () => ({
  computeFileHash: vi.fn(),
}));

vi.mock('./epub-content-evidence', () => ({
  extractEpubContentEvidence: vi.fn(),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { access, copyFile, link, mkdir, realpath, stat, unlink } from 'node:fs/promises';
import { computeFileHash } from '../../../common/utils/file-hash.utils';

import { extractEpubContentEvidence } from './epub-content-evidence';
import { ContentVerificationService } from './content-verification.service';

describe('ContentVerificationService', () => {
  const file = {
    fileId: 7,
    bookId: 4,
    libraryId: 2,
    absolutePath: '/books/Dune.epub',
    fileHash: 'abc123',
    format: 'epub',
    title: 'Dune',
    authors: ['Frank Herbert'],
  };
  const repository = {
    findFileForVerification: vi.fn(),
    findResultForFile: vi.fn(),
    listCandidates: vi.fn(),
    saveResult: vi.fn(),
    updateReview: vi.fn(),
    findCorrectionContext: vi.fn(),
    applyFileCorrection: vi.fn(),
    isBookFolderPathTaken: vi.fn(),
    findCorrectionFileLocation: vi.fn(),
  };
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([2]), findEditableLibraryIds: vi.fn().mockResolvedValue([2]) };
  const ai = { compare: vi.fn() };
  const transcription = { transcribe: vi.fn() };
  const config = { get: vi.fn().mockReturnValue('qwen3.5:4b') };
  const fileLock = { withLock: vi.fn((_key: string, operation: () => Promise<unknown>) => operation()) };
  const selfWriteRegistry = { track: vi.fn((_paths: string[], operation: () => Promise<unknown>) => operation()) };
  let service: ContentVerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(access).mockRejectedValue(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    vi.mocked(link).mockResolvedValue(undefined);
    vi.mocked(copyFile).mockResolvedValue(undefined);
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(realpath).mockImplementation((path) => Promise.resolve(String(path)));
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(stat).mockResolvedValue({ ino: 123n, size: 100n, mtime: new Date('2026-11-11T00:00:00Z') } as never);
    vi.mocked(computeFileHash).mockResolvedValue('abc123');
    libraryService.findAccessibleLibraryIds.mockResolvedValue([2]);
    repository.isBookFolderPathTaken.mockResolvedValue(false);
    service = new ContentVerificationService(
      repository as never,
      libraryService as never,
      ai as never,
      transcription as never,
      config as never,
      fileLock as never,
      selfWriteRegistry as never,
    );
    repository.findFileForVerification.mockResolvedValue(file);
    vi.mocked(extractEpubContentEvidence).mockResolvedValue({
      documents: [{ path: 'title.xhtml', text: 'Dune by Frank Herbert', likelyTitlePage: true }],
      truncated: false,
    });
    ai.compare.mockResolvedValue({
      status: 'match',
      detectedTitle: 'Dune',
      detectedAuthor: 'Frank Herbert',
      confidence: 0.99,
      evidence: 'Dune by Frank Herbert',
      explanation: 'The title page matches.',
    });
    repository.saveResult.mockImplementation((value: Record<string, unknown>) => ({ id: 1, ...value }));
  });

  it('records a human mismatch decision and reviewer note without changing metadata', async () => {
    repository.findResultForFile.mockResolvedValue({ fileHash: 'abc123', status: 'mismatch' });
    repository.updateReview.mockResolvedValue({
      fileHash: 'abc123',
      reviewStatus: 'confirmed_mismatch',
      reviewNote: 'This file contains a different novel.',
      reviewedBy: 10,
      stale: false,
    });

    await expect(
      service.reviewFile({ id: 10 } as never, 7, 'confirmed_mismatch', '  This file contains a different novel.  '),
    ).resolves.toMatchObject({
      reviewStatus: 'confirmed_mismatch',
      reviewNote: 'This file contains a different novel.',
      stale: false,
    });

    expect(repository.updateReview).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        reviewStatus: 'confirmed_mismatch',
        reviewNote: 'This file contains a different novel.',
        reviewedBy: 10,
        reviewedAt: expect.any(Date),
      }),
    );
  });

  it('rejects mismatch confirmation when the AI result is not a mismatch', async () => {
    repository.findResultForFile.mockResolvedValue({ fileHash: 'abc123', status: 'match' });
    await expect(service.reviewFile({ id: 10 } as never, 7, 'false_positive')).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.updateReview).not.toHaveBeenCalled();
  });

  it('allows a human to resolve an inconclusive result as a mismatch or false positive', async () => {
    repository.findResultForFile.mockResolvedValue({ fileHash: 'abc123', status: 'inconclusive' });
    repository.updateReview.mockResolvedValue({ fileHash: 'abc123', reviewStatus: 'confirmed_mismatch' });

    await expect(service.reviewFile({ id: 10 } as never, 7, 'confirmed_mismatch')).resolves.toMatchObject({
      reviewStatus: 'confirmed_mismatch',
    });

    expect(repository.updateReview).toHaveBeenLastCalledWith(7, expect.objectContaining({ reviewStatus: 'confirmed_mismatch', reviewedBy: 10 }));

    repository.updateReview.mockResolvedValue({ fileHash: 'abc123', reviewStatus: 'false_positive' });
    await expect(service.reviewFile({ id: 10 } as never, 7, 'false_positive')).resolves.toMatchObject({
      reviewStatus: 'false_positive',
    });
  });

  it('does not allow review when the verification result does not exist', async () => {
    repository.findResultForFile.mockResolvedValue(null);
    await expect(service.reviewFile({ id: 10 } as never, 7, 'false_positive')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.updateReview).not.toHaveBeenCalled();
  });

  it('previews splitting a mismatched format into a new book without mutating the file', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        sortOrder: 0,
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });

    const result = await service.previewCorrection({ id: 10 } as never, 7, {
      targetType: 'new_book',
      title: 'Corrected Novel',
      author: 'Jane Writer',
    });

    expect(result).toMatchObject({
      fileId: 7,
      sourceBookId: 4,
      destinationType: 'new_book',
      destinationTitle: 'Corrected Novel',
      destinationFolderPath: '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer',
      destinationPath: '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub',
      requiresApproval: true,
      executionAvailable: true,
    });
    expect(repository.findCorrectionContext).toHaveBeenCalledWith(7, [2], undefined);
  });

  it('requires the source path to remain unchanged between preview and locked execution', async () => {
    const context = (sourcePath: string) => ({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: sourcePath,
        relPath: sourcePath.split('/').slice(-2).join('/'),
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });
    repository.findCorrectionContext
      .mockResolvedValueOnce(context('/tmp/bookorbit-correction-test/Original Book/Original.epub'))
      .mockResolvedValueOnce(context('/tmp/bookorbit-correction-test/Original Book/Renamed.epub'));

    await expect(
      service.executeCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'Corrected Novel', author: 'Jane Writer' }),
    ).rejects.toThrow('source book changed while preparing this correction');

    expect(link).not.toHaveBeenCalled();
    expect(repository.applyFileCorrection).not.toHaveBeenCalled();
  });
  it('moves one confirmed mismatched format and preserves its file identity', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        sortOrder: 0,
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockResolvedValue({
      fileId: 7,
      sourceBookId: 4,
      destinationBookId: 91,
      targetType: 'new_book',
    });

    const result = await service.executeCorrection({ id: 10 } as never, 7, {
      targetType: 'new_book',
      title: 'Corrected Novel',
      author: 'Jane Writer',
    });

    const stagingPath = expect.stringMatching(/\.bookorbit-correction-7-.*\.tmp$/);
    expect(link).toHaveBeenNthCalledWith(1, '/tmp/bookorbit-correction-test/Original Book/Original.epub', stagingPath);
    expect(link).toHaveBeenNthCalledWith(2, stagingPath, '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub');
    expect(unlink).toHaveBeenCalledWith(stagingPath);
    expect(unlink).toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Original Book/Original.epub');
    expect(repository.applyFileCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 7,
        sourceBookId: 4,
        targetType: 'new_book',
        destinationPath: '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub',
        destinationRelPath: 'Corrected Novel - Jane Writer/Corrected Novel.epub',
        sourcePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        sourceHash: 'abc123',
        format: 'epub',
        reviewedBy: 10,
        title: 'Corrected Novel',
        author: 'Jane Writer',
      }),
    );
    expect(result).toMatchObject({
      fileId: 7,
      destinationBookId: 91,
      verificationEvidencePreserved: true,
      verificationRequiresRecheck: true,
      sourceCleanupPending: false,
      requiresRescan: false,
    });
    expect(selfWriteRegistry.track).toHaveBeenCalled();
  });

  it('reassigns a file without moving it when its path already matches the destination title', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-root',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-root/Correct Book.epub',
        absolutePath: '/tmp/bookorbit-root/Correct Book.epub',
        relPath: 'Correct Book.epub',
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Wrong Metadata Title',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: {
        bookId: 9,
        libraryId: 2,
        libraryFolderId: 3,
        folderPath: '/tmp/bookorbit-root/Correct Book.m4b',
        destinationFolderPath: '/tmp/bookorbit-root',
        title: 'Correct Book',
      },
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockResolvedValue({ fileId: 7, sourceBookId: 4, destinationBookId: 9, targetType: 'existing_book' });
    vi.mocked(access).mockImplementation((path) => {
      if (String(path) === '/tmp/bookorbit-root') {
        return Promise.resolve();
      }

      return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    });

    const result = await service.executeCorrection({ id: 10 } as never, 7, { targetType: 'existing_book', targetBookId: 9 });

    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(repository.applyFileCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: '/tmp/bookorbit-root/Correct Book.epub',
        destinationPath: '/tmp/bookorbit-root/Correct Book.epub',
      }),
    );
    expect(result).toMatchObject({ destinationBookId: 9, sourceCleanupPending: false });
  });
  it('moves a confirmed mismatched file into an existing book in the same library folder', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Wrong Metadata Title',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: {
        bookId: 9,
        libraryId: 2,
        libraryFolderId: 3,
        folderPath: '/tmp/bookorbit-correction-test/Correct Book',
        destinationFolderPath: '/tmp/bookorbit-correction-test/Correct Book',
        title: 'Correct Book',
      },
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockResolvedValue({
      fileId: 7,
      sourceBookId: 4,
      destinationBookId: 9,
      targetType: 'existing_book',
    });
    vi.mocked(access).mockImplementation((path) => {
      if (String(path) === '/tmp/bookorbit-correction-test/Correct Book') {
        return Promise.resolve();
      }

      return Promise.reject(Object.assign(new Error('not found'), { code: 'ENOENT' }));
    });

    const result = await service.executeCorrection({ id: 10 } as never, 7, { targetType: 'existing_book', targetBookId: 9 });

    const stagingPath = expect.stringMatching(/\.bookorbit-correction-7-.*\.tmp$/);
    expect(link).toHaveBeenNthCalledWith(1, '/tmp/bookorbit-correction-test/Original Book/Original.epub', stagingPath);
    expect(link).toHaveBeenNthCalledWith(2, stagingPath, '/tmp/bookorbit-correction-test/Correct Book/Correct Book.epub');
    expect(unlink).toHaveBeenCalledWith(stagingPath);
    expect(repository.applyFileCorrection).toHaveBeenCalledWith(
      expect.objectContaining({
        fileId: 7,
        sourceBookId: 4,
        targetBookId: 9,
        targetType: 'existing_book',
        destinationFolderPath: '/tmp/bookorbit-correction-test/Correct Book',
        targetBookFolderPath: '/tmp/bookorbit-correction-test/Correct Book',
      }),
    );
    expect(result).toMatchObject({ destinationBookId: 9, verificationEvidencePreserved: true });
  });

  it('uses an exclusive copy when the filesystem cannot create a hard link', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockResolvedValue({ fileId: 7, sourceBookId: 4, destinationBookId: 91, targetType: 'new_book' });
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));

    const result = await service.executeCorrection({ id: 10 } as never, 7, {
      targetType: 'new_book',
      title: 'Corrected Novel',
      author: 'Jane Writer',
    });

    const stagingPath = expect.stringMatching(/\.bookorbit-correction-7-.*\.tmp$/);
    expect(copyFile).toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Original Book/Original.epub', stagingPath, expect.any(Number));
    expect(link).toHaveBeenNthCalledWith(2, stagingPath, '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub');
    expect(unlink).toHaveBeenCalledWith(stagingPath);
    expect(unlink).toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Original Book/Original.epub');
    expect(result).toMatchObject({ destinationBookId: 91, sourceCleanupPending: false });
  });
  it('keeps the original path when the database reassignment fails', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockRejectedValueOnce(new Error('Database update failed'));
    repository.findCorrectionFileLocation.mockResolvedValue({
      fileId: 7,
      bookId: 4,
      absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
    });

    await expect(
      service.executeCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'Corrected Novel', author: 'Jane Writer' }),
    ).rejects.toThrow('Database update failed');

    expect(link).toHaveBeenCalledTimes(2);
    expect(unlink).toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub');
    expect(unlink).not.toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Original Book/Original.epub');
  });

  it('retains both paths when the database commit outcome cannot be checked', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        fileId: 7,
        bookId: 4,
        libraryId: 2,
        libraryFolderId: 3,
        libraryFolderPath: '/tmp/bookorbit-correction-test',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original Book',
        absolutePath: '/tmp/bookorbit-correction-test/Original Book/Original.epub',
        relPath: 'Original Book/Original.epub',
        format: 'epub',
        role: 'content',
        fileHash: 'abc123',
        title: 'Original Book',
        verificationStatus: 'mismatch',
        verificationFileHash: 'abc123',
        reviewStatus: 'confirmed_mismatch',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });
    repository.applyFileCorrection.mockRejectedValueOnce(new Error('Connection interrupted'));
    repository.findCorrectionFileLocation.mockRejectedValueOnce(new Error('Database unavailable'));

    await expect(
      service.executeCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'Corrected Novel', author: 'Jane Writer' }),
    ).rejects.toThrow('Correction did not complete cleanly');

    expect(unlink).not.toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Original Book/Original.epub');
    expect(unlink).not.toHaveBeenCalledWith('/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub');
  });
  it('requires a confirmed mismatch before offering a file correction', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: { role: 'content', reviewStatus: null },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });

    await expect(
      service.previewCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'New Title', author: 'New Author' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects correction when the saved evidence belongs to an older file hash', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        role: 'content',
        reviewStatus: 'confirmed_mismatch',
        fileHash: 'new-hash',
        verificationFileHash: 'old-hash',
      },
      contentFileCount: 2,
      audioContentCount: 0,
      target: null,
      targetFormatCount: 0,
    });

    await expect(
      service.previewCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'New Title', author: 'New Author' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects splitting one part out of a multipart audiobook', async () => {
    repository.findCorrectionContext.mockResolvedValue({
      source: {
        role: 'content',
        reviewStatus: 'confirmed_mismatch',
        fileHash: 'abc123',
        verificationFileHash: 'abc123',
        absolutePath: '/tmp/bookorbit-correction-test/Original/Part 1.m4b',
        format: 'm4b',
        organizationMode: 'book_per_folder',
        bookFolderPath: '/tmp/bookorbit-correction-test/Original',
        libraryFolderPath: '/tmp/bookorbit-correction-test',
      },
      contentFileCount: 2,
      audioContentCount: 2,
      target: null,
      targetFormatCount: 0,
    });

    await expect(
      service.previewCorrection({ id: 10 } as never, 7, { targetType: 'new_book', title: 'New Title', author: 'New Author' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('verifies EPUB evidence and stores a result without changing book metadata', async () => {
    const result = await service.verifyFile({ id: 10 } as never, 7);

    expect(extractEpubContentEvidence).toHaveBeenCalledWith('/books/Dune.epub');
    expect(ai.compare).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTitle: 'Dune',
        expectedAuthors: ['Frank Herbert'],
        source: 'ebook',
      }),
    );
    expect(repository.saveResult).toHaveBeenCalledWith(
      expect.objectContaining({
        bookFileId: 7,
        fileHash: 'abc123',
        status: 'match',
      }),
    );
    expect(result).toMatchObject({ status: 'match', stale: false });
  });

  it('does not mark a low-confidence title detection as a verified match', async () => {
    ai.compare.mockResolvedValue({
      status: 'match',
      detectedTitle: 'Dune',
      detectedAuthor: 'Frank Herbert',
      confidence: 0.6,
      evidence: 'Dune',
      explanation: 'The sample is too short to be certain.',
    });

    await service.verifyFile({ id: 10 } as never, 7);

    expect(repository.saveResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'inconclusive' }));
  });

  it('uses only the opening audiobook transcript as comparison evidence', async () => {
    repository.findFileForVerification.mockResolvedValue({
      ...file,
      absolutePath: '/books/Dune.m4b',
      format: 'm4b',
    });
    transcription.transcribe.mockResolvedValue({
      transcript: 'Dune, by Frank Herbert.',
      sampleSeconds: 30,
      model: 'faster-whisper',
    });

    await service.verifyFile({ id: 10 } as never, 7);

    expect(transcription.transcribe).toHaveBeenCalledWith('/books/Dune.m4b');
    expect(ai.compare).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'audiobook',
        evidence: [{ label: 'Opening audio transcript (30 seconds)', text: 'Dune, by Frank Herbert.' }],
      }),
    );
  });

  it('does not expose files outside the user accessible libraries', async () => {
    repository.findFileForVerification.mockResolvedValue(null);
    await expect(service.verifyFile({ id: 10 } as never, 7)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires a metadata title before verification', async () => {
    repository.findFileForVerification.mockResolvedValue({ ...file, title: null });
    await expect(service.verifyFile({ id: 10 } as never, 7)).rejects.toBeInstanceOf(BadRequestException);
  });
});
