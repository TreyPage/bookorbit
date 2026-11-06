import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { LibraryIntegrityController } from './library-integrity.controller';

describe('LibraryIntegrityController', () => {
  it('requires library deletion permission to inspect library integrity', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, LibraryIntegrityController)).toBe(Permission.LibraryDeleteBooks);
  });

  it('returns the most recent scheduled integrity scan status', () => {
    const status = { status: 'completed', summary: { libraryCount: 1 } };
    const scanScheduler = { getLastScan: vi.fn().mockReturnValue(status) };
    const controller = new LibraryIntegrityController({} as never, scanScheduler as never);

    expect(controller.getScanStatus()).toEqual(status);
    expect(scanScheduler.getLastScan).toHaveBeenCalledOnce();
  });

  it('delegates similar-series discovery with the current user', async () => {
    const service = { listSimilarSeries: vi.fn().mockResolvedValue({ items: [], truncated: false }) };
    const controller = new LibraryIntegrityController(service as never, { getLastScan: vi.fn() } as never);
    const user = { id: 9 } as never;

    await controller.listSimilarSeries(user);

    expect(service.listSimilarSeries).toHaveBeenCalledWith(user);
  });

  it('delegates series merge with the current user and validated request', async () => {
    const dto = { targetSeriesId: 10, sourceSeriesIds: [11], confirmPositionConflicts: false };
    const service = { mergeSeries: vi.fn().mockResolvedValue({ status: 'merged' }) };
    const controller = new LibraryIntegrityController(service as never, { getLastScan: vi.fn() } as never);
    const user = { id: 9 } as never;

    await controller.mergeSeries(dto as never, user);

    expect(service.mergeSeries).toHaveBeenCalledWith(user, dto);
  });

  it('delegates duplicate-format listing with pagination and current user', async () => {
    const service = { listDuplicateFormats: vi.fn().mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20 }) };
    const controller = new LibraryIntegrityController(service as never, { getLastScan: vi.fn() } as never);
    const user = { id: 9 } as never;

    await controller.listDuplicateFormats({ page: 2, pageSize: 20 }, user);

    expect(service.listDuplicateFormats).toHaveBeenCalledWith(user, 2, 20);
  });
});
