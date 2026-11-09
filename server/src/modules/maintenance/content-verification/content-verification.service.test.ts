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
  };
  const libraryService = { findAccessibleLibraryIds: vi.fn().mockResolvedValue([2]) };
  const ai = { compare: vi.fn() };
  const transcription = { transcribe: vi.fn() };
  const config = { get: vi.fn().mockReturnValue('qwen3.5:4b') };
  let service: ContentVerificationService;

  beforeEach(() => {
    vi.clearAllMocks();
    libraryService.findAccessibleLibraryIds.mockResolvedValue([2]);
    service = new ContentVerificationService(
      repository as never,
      libraryService as never,
      ai as never,
      transcription as never,
      config as never,
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
    repository.saveResult.mockImplementation(async (value: Record<string, unknown>) => ({ id: 1, ...value }));
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

    await expect(service.reviewFile(
      { id: 10 } as never,
      7,
      'confirmed_mismatch',
      '  This file contains a different novel.  ',
    )).resolves.toMatchObject({
      reviewStatus: 'confirmed_mismatch',
      reviewNote: 'This file contains a different novel.',
      stale: false,
    });

    expect(repository.updateReview).toHaveBeenCalledWith(7, expect.objectContaining({
      reviewStatus: 'confirmed_mismatch',
      reviewNote: 'This file contains a different novel.',
      reviewedBy: 10,
      reviewedAt: expect.any(Date),
    }));
  });

  it('rejects mismatch confirmation when the AI result is not a mismatch', async () => {
    repository.findResultForFile.mockResolvedValue({ fileHash: 'abc123', status: 'match' });
    await expect(service.reviewFile({ id: 10 } as never, 7, 'false_positive')).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.updateReview).not.toHaveBeenCalled();
  });

  it('does not allow review when the verification result does not exist', async () => {
    repository.findResultForFile.mockResolvedValue(null);
    await expect(service.reviewFile({ id: 10 } as never, 7, 'false_positive')).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.updateReview).not.toHaveBeenCalled();
  });

  it('verifies EPUB evidence and stores a result without changing book metadata', async () => {
    const result = await service.verifyFile({ id: 10 } as never, 7);

    expect(extractEpubContentEvidence).toHaveBeenCalledWith('/books/Dune.epub');
    expect(ai.compare).toHaveBeenCalledWith(expect.objectContaining({
      expectedTitle: 'Dune',
      expectedAuthors: ['Frank Herbert'],
      source: 'ebook',
    }));
    expect(repository.saveResult).toHaveBeenCalledWith(expect.objectContaining({
      bookFileId: 7,
      fileHash: 'abc123',
      status: 'match',
    }));
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
    expect(ai.compare).toHaveBeenCalledWith(expect.objectContaining({
      source: 'audiobook',
      evidence: [{ label: 'Opening audio transcript (30 seconds)', text: 'Dune, by Frank Herbert.' }],
    }));
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
