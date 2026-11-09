import type { BookRequestDownloadRow } from '../../../db/schema';
import type { DownloadStatus } from '../download-clients/download-client-adapter';
import { RequestSeedCleanupSchedulerService } from './request-seed-cleanup-scheduler.service';

const HASH_A = 'c9e15763f722f23e98a29decdfae341b98d53056';
const HASH_B = 'd7e15763f722f23e98a29decdfae341b98d53057';

function download(id: number, clientKey: string): BookRequestDownloadRow {
  return {
    id,
    requestId: id + 100,
    downloadClientId: 4,
    clientKey,
    source: 'torrent_file',
    status: 'imported',
  } as BookRequestDownloadRow;
}

function status(clientKey: string, seed: Partial<NonNullable<DownloadStatus['seed']>>): DownloadStatus {
  return {
    clientKey,
    state: 'completed',
    progressPercent: 100,
    downloadedBytes: 100,
    totalBytes: 100,
    contentPath: '/downloads/book',
    seed: {
      seeding: true,
      ratio: null,
      ratioGoal: null,
      seedingTimeSeconds: null,
      seedingTimeGoalMinutes: null,
      uploadedBytes: null,
      ...seed,
    },
  };
}

function makeService(rows = [download(1, HASH_A), download(2, HASH_B)], statuses: DownloadStatus[] = []) {
  const downloads = {
    findImportedTorrentSeeds: vi.fn().mockResolvedValue(rows),
    isSeedCleanupProtected: vi.fn().mockResolvedValue(false),
    updateIf: vi.fn().mockResolvedValue({}),
  };
  const clients = { resolveConfig: vi.fn().mockResolvedValue({ id: 4, adapterType: 'qbittorrent' }) };
  const adapter = { status: vi.fn().mockResolvedValue(statuses) };
  const registry = { require: vi.fn().mockReturnValue(adapter) };
  const removal = { detachAttempt: vi.fn().mockResolvedValue(null) };
  const auditEvents = { emit: vi.fn() };
  const service = new RequestSeedCleanupSchedulerService(
    downloads as never,
    clients as never,
    registry as never,
    removal as never,
    auditEvents as never,
  );

  return { service, downloads, clients, adapter, registry, removal, auditEvents };
}

describe('RequestSeedCleanupSchedulerService', () => {
  it('removes a torrent when its configured ratio goal is reached and keeps its files', async () => {
    const row = download(1, HASH_A);
    const { service, downloads, adapter, removal, auditEvents } = makeService([row], [status(HASH_A, { ratio: 2.1, ratioGoal: 2 })]);

    await service.tick();

    expect(adapter.status).toHaveBeenCalledWith([HASH_A], expect.anything());
    expect(removal.detachAttempt).toHaveBeenCalledWith(row, false);
    expect(downloads.updateIf).toHaveBeenCalledWith(1, ['imported'], { clientKey: null });
    expect(auditEvents.emit).toHaveBeenCalledWith('audit.log', expect.objectContaining({ action: 'book_request.seed_cleanup', resourceId: row.requestId }));
  });

  it('leaves a torrent attached when request protection is enabled, even after its goal is reached', async () => {
    const row = download(1, HASH_A);
    const { service, downloads, removal } = makeService([row], [status(HASH_A, { ratio: 2, ratioGoal: 2 })]);
    downloads.isSeedCleanupProtected.mockResolvedValue(true);

    await service.tick();

    expect(downloads.isSeedCleanupProtected).toHaveBeenCalledWith(row.requestId);
    expect(removal.detachAttempt).not.toHaveBeenCalled();
  });

  it('removes a torrent when its configured seeding-time goal is reached', async () => {
    const row = download(1, HASH_A);
    const { service, removal } = makeService([row], [
      status(HASH_A, { seedingTimeSeconds: 3 * 60 * 60, seedingTimeGoalMinutes: 180 }),
    ]);

    await service.tick();

    expect(removal.detachAttempt).toHaveBeenCalledWith(row, false);
  });

  it('uses ratio OR time, not both, when either configured goal is met', async () => {
    const row = download(1, HASH_A);
    const { service, removal } = makeService([row], [
      status(HASH_A, { ratio: 1, ratioGoal: 2, seedingTimeSeconds: 60 * 60, seedingTimeGoalMinutes: 60 }),
    ]);

    await service.tick();

    expect(removal.detachAttempt).toHaveBeenCalledWith(row, false);
  });

  it('does not remove a seed before its configured goals are reached', async () => {
    const { service, removal } = makeService([download(1, HASH_A)], [
      status(HASH_A, { ratio: 1.9, ratioGoal: 2, seedingTimeSeconds: 59 * 60, seedingTimeGoalMinutes: 60 }),
    ]);

    await service.tick();

    expect(removal.detachAttempt).not.toHaveBeenCalled();
  });

  it('leaves torrents alone when the client reports no explicit seed goal', async () => {
    const { service, removal } = makeService([download(1, HASH_A)], [status(HASH_A, { ratio: 100, ratioGoal: null })]);

    await service.tick();

    expect(removal.detachAttempt).not.toHaveBeenCalled();
  });

  it('batches all tracked torrents for one client into a single status request', async () => {
    const { service, adapter } = makeService(
      [download(1, HASH_A), download(2, HASH_B)],
      [status(HASH_A, { ratio: 1, ratioGoal: 2 }), status(HASH_B, { ratio: 1, ratioGoal: 2 })],
    );

    await service.tick();

    expect(adapter.status).toHaveBeenCalledTimes(1);
    expect(adapter.status).toHaveBeenCalledWith([HASH_A, HASH_B], expect.anything());
  });

  it('continues after a client removal error so other seeds can still be processed', async () => {
    const first = download(1, HASH_A);
    const second = download(2, HASH_B);
    const { service, removal } = makeService(
      [first, second],
      [status(HASH_A, { ratio: 2, ratioGoal: 2 }), status(HASH_B, { ratio: 2, ratioGoal: 2 })],
    );
    removal.detachAttempt.mockResolvedValueOnce('client unavailable').mockResolvedValueOnce(null);

    await expect(service.tick()).resolves.toBeUndefined();

    expect(removal.detachAttempt).toHaveBeenCalledTimes(2);
  });

  it('does not query clients when there are no imported torrent attempts', async () => {
    const { service, clients, adapter } = makeService([], []);

    await service.tick();

    expect(clients.resolveConfig).not.toHaveBeenCalled();
    expect(adapter.status).not.toHaveBeenCalled();
  });

  it('continues to later pages when earlier imported seeds have not reached a goal', async () => {
    const firstPage = Array.from({ length: 500 }, (_, index) => download(index + 1, index.toString(16).padStart(40, '0')));
    const finalRow = download(501, HASH_B);
    const { service, downloads, removal } = makeService([finalRow], [status(HASH_B, { ratio: 2, ratioGoal: 2 })]);
    downloads.findImportedTorrentSeeds.mockImplementation((afterId: number) => (afterId === 0 ? firstPage : [finalRow]));

    await service.tick();

    expect(downloads.findImportedTorrentSeeds).toHaveBeenCalledTimes(2);
    expect(removal.detachAttempt).toHaveBeenCalledWith(finalRow, false);
  });

  it('does not overlap two scheduler ticks', async () => {
    const { service, downloads } = makeService();
    let release!: () => void;
    downloads.findImportedTorrentSeeds.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve([]); }),
    );

    const first = service.tick();
    await service.tick();
    release();
    await first;

    expect(downloads.findImportedTorrentSeeds).toHaveBeenCalledTimes(1);
  });
});
