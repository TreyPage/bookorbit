import { Logger } from '@nestjs/common';

import { LibraryIntegrityScanSchedulerService } from './library-integrity-scan-scheduler.service';

describe('LibraryIntegrityScanSchedulerService', () => {
  it('runs a read-only scan and exposes the completed summary', async () => {
    const integrityService = {
      scanAllLibraries: vi.fn().mockResolvedValue({
        libraryCount: 2,
        duplicateFormatGroups: 3,
        duplicateFormatFiles: 6,
        sidecarEntries: 4,
        sidecarScanTruncated: false,
        orphanedMetadataFiles: 2,
        orphanedBookFolders: 1,
        orphanedFiles: 3,
        emptyBookFolders: 1,
        orphanedCoverDirectories: 3,
        orphanedCoverBytes: 2048,
        filesystemScanTruncated: false,
      }),
    };
    const service = new LibraryIntegrityScanSchedulerService(
      integrityService as never,
      { saveLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(undefined) } as never,
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const result = await service.runNow();

    expect(result).toMatchObject({
      status: 'completed',
      summary: {
        libraryCount: 2,
        duplicateFormatGroups: 3,
        duplicateFormatFiles: 6,
        sidecarEntries: 4,
        orphanedMetadataFiles: 2,
        emptyBookFolders: 1,
        orphanedCoverDirectories: 3,
        orphanedCoverBytes: 2048,
      },
      errorMessage: null,
    });
    expect(integrityService.scanAllLibraries).toHaveBeenCalledOnce();
    expect(service.getLastScan()).toEqual(result);
  });

  it('does not start a second scan while one is running', async () => {
    let finish!: (value: never) => void;
    const integrityService = {
      scanAllLibraries: vi.fn().mockReturnValue(
        new Promise((resolve) => {
          finish = resolve;
        }),
      ),
    };
    const service = new LibraryIntegrityScanSchedulerService(
      integrityService as never,
      { saveLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(undefined) } as never,
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const first = service.runNow();
    const second = await service.runNow();
    await vi.waitFor(() => expect(integrityService.scanAllLibraries).toHaveBeenCalledOnce());

    expect(integrityService.scanAllLibraries).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ status: 'running' });
    finish({
      libraryCount: 0,
      duplicateFormatGroups: 0,
      duplicateFormatFiles: 0,
      sidecarEntries: 0,
      sidecarScanTruncated: false,
      orphanedMetadataFiles: 0,
      orphanedBookFolders: 0,
      orphanedFiles: 0,
      emptyBookFolders: 0,
      orphanedCoverDirectories: 0,
      orphanedCoverBytes: 0,
      filesystemScanTruncated: false,
    } as never);
    await first;
  });

  it('records failures without throwing from the scheduled callback', async () => {
    const integrityService = { scanAllLibraries: vi.fn().mockRejectedValue(new Error('disk unavailable\nretry later')) };
    const service = new LibraryIntegrityScanSchedulerService(
      integrityService as never,
      { saveLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(undefined) } as never,
    );
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.runScheduledScan()).resolves.toBeUndefined();
    expect(service.getLastScan()).toMatchObject({ status: 'failed', errorMessage: 'disk unavailable retry later' });
  });
});
describe('LibraryIntegrityScanSchedulerService persistence', () => {
  it('restores the latest completed scan after restart', async () => {
    const persisted = {
      status: 'completed',
      startedAt: '2026-11-06T10:00:00.000Z',
      completedAt: '2026-11-06T10:01:00.000Z',
      summary: null,
      errorMessage: null,
    };
    const repository = { getLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(persisted), saveLibraryIntegrityScanStatus: vi.fn() };
    const service = new LibraryIntegrityScanSchedulerService({} as never, repository as never);
    await service.onModuleInit();
    expect(service.getLastScan()).toEqual(persisted);
  });

  it('marks a scan interrupted by restart as failed', async () => {
    const persisted = { status: 'running', startedAt: '2026-11-06T10:00:00.000Z', completedAt: null, summary: null, errorMessage: null };
    const repository = {
      getLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(persisted),
      saveLibraryIntegrityScanStatus: vi.fn().mockResolvedValue(undefined),
    };
    const service = new LibraryIntegrityScanSchedulerService({} as never, repository as never);
    await service.onModuleInit();
    expect(service.getLastScan()).toMatchObject({ status: 'failed', errorMessage: 'Scan interrupted by application restart.' });
    expect(repository.saveLibraryIntegrityScanStatus).toHaveBeenCalledOnce();
  });
});
