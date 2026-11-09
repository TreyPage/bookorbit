import { Logger } from '@nestjs/common';

import { ContentVerificationSchedulerService } from './content-verification-scheduler.service';

describe('ContentVerificationSchedulerService', () => {
  const candidates = [
    { fileId: 2, format: 'epub' },
    { fileId: 5, format: 'epub' },
  ];

  it('does not process files until the AI provider is configured', async () => {
    const repository = { listPendingCandidates: vi.fn() };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(false) };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    await expect(service.runBatch()).resolves.toMatchObject({ status: 'waiting_for_provider' });
    expect(repository.listPendingCandidates).not.toHaveBeenCalled();
  });

  it('queues newly imported books and starts verification immediately', async () => {
    const repository = {
      listVerificationFileIdsForBooks: vi.fn().mockResolvedValue([12, 13]),
      listPendingCandidates: vi.fn().mockResolvedValue([]),
    };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn().mockResolvedValue({ status: 'match' }),
    };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    await service.enqueueBooks([4, 4, 9]);
    await vi.waitFor(() => expect(verification.verifyFileForSystem).toHaveBeenCalledTimes(2));

    expect(repository.listVerificationFileIdsForBooks).toHaveBeenCalledWith([4, 9], false);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(1, 12);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(2, 13);
  });

  it('does not enqueue imported books when the AI provider is unavailable', async () => {
    const repository = { listVerificationFileIdsForBooks: vi.fn() };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(false) };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    await service.enqueueBooks([4]);

    expect(repository.listVerificationFileIdsForBooks).not.toHaveBeenCalled();
  });

  it('processes a bounded batch and records result counts', async () => {
    const repository = { listPendingCandidates: vi.fn().mockResolvedValue(candidates) };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn()
        .mockResolvedValueOnce({ status: 'match' })
        .mockResolvedValueOnce({ status: 'inconclusive' }),
    };
    const transcription = { isConfigured: vi.fn().mockReturnValue(true) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    await expect(service.runBatch()).resolves.toMatchObject({
      status: 'idle',
      processed: 2,
      matches: 1,
      mismatches: 0,
      inconclusive: 1,
      errors: 0,
    });
    expect(repository.listPendingCandidates).toHaveBeenCalledWith(0, 5, true);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(1, 2);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(2, 5);
  });

  it('continues after a failed file and advances the cursor past it', async () => {
    const repository = { listPendingCandidates: vi.fn().mockResolvedValue(candidates) };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn()
        .mockRejectedValueOnce(new Error('bad epub'))
        .mockResolvedValueOnce({ status: 'match' }),
    };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.runBatch()).resolves.toMatchObject({ processed: 2, errors: 1, matches: 1, lastError: 'bad epub' });
    repository.listPendingCandidates.mockResolvedValue([{ fileId: 9, format: 'epub' }]);
    await service.runBatch();

    expect(repository.listPendingCandidates).toHaveBeenLastCalledWith(5, 5, false);
    expect(verification.verifyFileForSystem).toHaveBeenLastCalledWith(9);
  });

  it('does not overlap concurrent batches', async () => {
    let finish!: (value: never) => void;
    const repository = { listPendingCandidates: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; })) };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(true), verifyFileForSystem: vi.fn() };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    const first = service.runBatch();
    await vi.waitFor(() => expect(repository.listPendingCandidates).toHaveBeenCalledOnce());
    await expect(service.runBatch()).resolves.toMatchObject({ status: 'running' });
    expect(repository.listPendingCandidates).toHaveBeenCalledOnce();
    finish([] as never);
    await first;
  });

  it('resets the cursor after reaching the end of the pending queue', async () => {
    const repository = { listPendingCandidates: vi.fn().mockResolvedValueOnce(candidates).mockResolvedValueOnce([]).mockResolvedValueOnce([{ fileId: 1, format: 'epub' }]) };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(true), verifyFileForSystem: vi.fn().mockResolvedValue({ status: 'match' }) };
    const transcription = { isConfigured: vi.fn().mockReturnValue(false) };
    const service = new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never);

    await service.runBatch();
    await service.runBatch();
    await service.runBatch();

    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(1, 0, 5, false);
    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(2, 5, 5, false);
    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(3, 0, 5, false);
  });
});
