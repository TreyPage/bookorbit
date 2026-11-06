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
      }),
    };
    const service = new LibraryIntegrityScanSchedulerService(integrityService as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const result = await service.runNow();

    expect(result).toMatchObject({
      status: 'completed',
      summary: { libraryCount: 2, duplicateFormatGroups: 3, duplicateFormatFiles: 6, sidecarEntries: 4 },
      errorMessage: null,
    });
    expect(integrityService.scanAllLibraries).toHaveBeenCalledOnce();
    expect(service.getLastScan()).toEqual(result);
  });

  it('does not start a second scan while one is running', async () => {
    let finish!: (value: never) => void;
    const integrityService = { scanAllLibraries: vi.fn().mockReturnValue(new Promise((resolve) => { finish = resolve; })) };
    const service = new LibraryIntegrityScanSchedulerService(integrityService as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const first = service.runNow();
    const second = await service.runNow();

    expect(integrityService.scanAllLibraries).toHaveBeenCalledOnce();
    expect(second).toMatchObject({ status: 'running' });
    finish({
      libraryCount: 0, duplicateFormatGroups: 0, duplicateFormatFiles: 0, sidecarEntries: 0, sidecarScanTruncated: false,
    } as never);
    await first;
  });

  it('records failures without throwing from the scheduled callback', async () => {
    const integrityService = { scanAllLibraries: vi.fn().mockRejectedValue(new Error('disk unavailable\nretry later')) };
    const service = new LibraryIntegrityScanSchedulerService(integrityService as never);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    await expect(service.runScheduledScan()).resolves.toBeUndefined();
    expect(service.getLastScan()).toMatchObject({ status: 'failed', errorMessage: 'disk unavailable retry later' });
  });
});
