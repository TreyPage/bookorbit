vi.mock('./epub-content-evidence', () => ({
  extractEpubContentEvidence: vi.fn(),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';

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
  };
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([2]), findEditableLibraryIds: vi.fn().mockResolvedValue([2]) };
  const ai = { compare: vi.fn() };
  const transcription = { transcribe: vi.fn() };
  const config = { get: vi.fn().mockReturnValue('qwen3.5:4b') };
  let service: ContentVerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    libraryService.findAccessibleLibraryIds.mockResolvedValue([2]);
    service = new ContentVerificationService(repository as never, libraryService as never, ai as never, transcription as never, config as never);
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

    const result = await service.previewCorrection(
      { id: 10 } as never,
      7,
      { targetType: 'new_book', title: 'Corrected Novel', author: 'Jane Writer' },
    );

    expect(result).toMatchObject({
      fileId: 7,
      sourceBookId: 4,
      destinationType: 'new_book',
      destinationTitle: 'Corrected Novel',
      destinationFolderPath: '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer',
      destinationPath: '/tmp/bookorbit-correction-test/Corrected Novel - Jane Writer/Corrected Novel.epub',
      requiresApproval: true,
      executionAvailable: false,
    });
    expect(repository.findCorrectionContext).toHaveBeenCalledWith(7, [2], undefined);
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
