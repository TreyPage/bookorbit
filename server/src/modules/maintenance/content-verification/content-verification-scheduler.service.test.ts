import { Logger } from '@nestjs/common';

import { ContentVerificationSchedulerService } from './content-verification-scheduler.service';

describe('ContentVerificationSchedulerService', () => {
  const candidates = [
    { fileId: 2, format: 'epub' },
    { fileId: 5, format: 'epub' },
  ];
  const schedule = { enabled: true, startTime: '01:00', endTime: '06:00', batchSize: 3, delaySeconds: 0 };
  const settings = { getValue: vi.fn().mockResolvedValue(JSON.stringify(schedule)), setValue: vi.fn().mockResolvedValue(undefined) };

  function createService(repository: Record<string, unknown>, verification: Record<string, unknown>, transcription = { isConfigured: vi.fn().mockReturnValue(false) }) {
    return new ContentVerificationSchedulerService(repository as never, verification as never, transcription as never, settings as never);
  }

  beforeEach(() => {
    settings.getValue.mockResolvedValue(JSON.stringify(schedule));
    settings.setValue.mockClear();
  });

  it('does not process files until the AI provider is configured', async () => {
    const repository = { listPendingCandidates: vi.fn() };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(false) };
    const service = createService(repository, verification);

    await expect(service.runBatch(true)).resolves.toMatchObject({ status: 'waiting_for_provider' });
    expect(repository.listPendingCandidates).not.toHaveBeenCalled();
  });

  it('queues imported books without starting AI work immediately', async () => {
    const repository = {
      listVerificationFileIdsForBooks: vi.fn().mockResolvedValue([12, 13]),
      listPendingCandidates: vi.fn().mockResolvedValue([]),
    };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn().mockResolvedValue({ status: 'match' }),
    };
    const service = createService(repository, verification);

    await service.enqueueBooks([4, 4, 9]);

    expect(repository.listVerificationFileIdsForBooks).toHaveBeenCalledWith([4, 9], false);
    expect(verification.verifyFileForSystem).not.toHaveBeenCalled();

    await service.runBatch(true);
    expect(verification.verifyFileForSystem).toHaveBeenCalledTimes(2);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(1, 12);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(2, 13);
  });

  it('does not enqueue imported books when the AI provider is unavailable', async () => {
    const repository = { listVerificationFileIdsForBooks: vi.fn() };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(false) };
    const service = createService(repository, verification);

    await service.enqueueBooks([4]);

    expect(repository.listVerificationFileIdsForBooks).not.toHaveBeenCalled();
  });

  it('processes a bounded batch and records result counts', async () => {
    const repository = { listPendingCandidates: vi.fn().mockResolvedValue(candidates) };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn().mockResolvedValueOnce({ status: 'match' }).mockResolvedValueOnce({ status: 'inconclusive' }),
    };
    const service = createService(repository, verification, { isConfigured: vi.fn().mockReturnValue(true) });

    await expect(service.runBatch(true)).resolves.toMatchObject({
      status: 'idle',
      processed: 2,
      matches: 1,
      mismatches: 0,
      inconclusive: 1,
      errors: 0,
    });
    expect(repository.listPendingCandidates).toHaveBeenCalledWith(0, 3, true);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(1, 2);
    expect(verification.verifyFileForSystem).toHaveBeenNthCalledWith(2, 5);
  });

  it('continues after a failed file and advances the cursor past it', async () => {
    const repository = { listPendingCandidates: vi.fn().mockResolvedValue(candidates) };
    const verification = {
      isAiConfigured: vi.fn().mockReturnValue(true),
      verifyFileForSystem: vi.fn().mockRejectedValueOnce(new Error('bad epub')).mockResolvedValueOnce({ status: 'match' }),
    };
    const service = createService(repository, verification);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await expect(service.runBatch(true)).resolves.toMatchObject({ processed: 2, errors: 1, matches: 1, lastError: 'bad epub' });
    repository.listPendingCandidates.mockResolvedValue([{ fileId: 9, format: 'epub' }]);
    await service.runBatch(true);

    expect(repository.listPendingCandidates).toHaveBeenLastCalledWith(5, 3, false);
    expect(verification.verifyFileForSystem).toHaveBeenLastCalledWith(9);
  });

  it('does not overlap concurrent batches', async () => {
    let finish!: (value: never) => void;
    const repository = {
      listPendingCandidates: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; })),
    };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(true), verifyFileForSystem: vi.fn() };
    const service = createService(repository, verification);

    const first = service.runBatch(true);
    await vi.waitFor(() => expect(repository.listPendingCandidates).toHaveBeenCalledOnce());
    await expect(service.runBatch(true)).resolves.toMatchObject({ status: 'running' });
    expect(repository.listPendingCandidates).toHaveBeenCalledOnce();
    finish([] as never);
    await first;
  });

  it('resets the cursor after reaching the end of the pending queue', async () => {
    const repository = {
      listPendingCandidates: vi.fn()
        .mockResolvedValueOnce(candidates)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ fileId: 1, format: 'epub' }]),
    };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(true), verifyFileForSystem: vi.fn().mockResolvedValue({ status: 'match' }) };
    const service = createService(repository, verification);

    await service.runBatch(true);
    await service.runBatch(true);
    await service.runBatch(true);

    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(1, 0, 3, false);
    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(2, 5, 3, false);
    expect(repository.listPendingCandidates).toHaveBeenNthCalledWith(3, 0, 3, false);
  });

  it('persists validated schedule changes', async () => {
    const repository = { listPendingCandidates: vi.fn() };
    const verification = { isAiConfigured: vi.fn().mockReturnValue(true) };
    const service = createService(repository, verification);

    await expect(service.updateSchedule({ batchSize: 4, delaySeconds: 15 })).resolves.toEqual({
      ...schedule,
      batchSize: 4,
      delaySeconds: 15,
    });
    expect(settings.setValue).toHaveBeenCalledWith(
      'content_verification_schedule',
      JSON.stringify({ ...schedule, batchSize: 4, delaySeconds: 15 }),
    );
  });
});
