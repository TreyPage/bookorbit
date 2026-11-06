import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { LibraryIntegrityController } from './library-integrity.controller';

describe('LibraryIntegrityController', () => {
  it('requires library deletion permission to inspect library integrity', () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, LibraryIntegrityController)).toBe(Permission.LibraryDeleteBooks);
  });

  it('delegates similar-series discovery with the current user', async () => {
    const service = { listSimilarSeries: vi.fn().mockResolvedValue({ items: [], truncated: false }) };
    const controller = new LibraryIntegrityController(service as never);
    const user = { id: 9 } as never;

    await controller.listSimilarSeries(user);

    expect(service.listSimilarSeries).toHaveBeenCalledWith(user);
  });

  it('delegates duplicate-format listing with pagination and current user', async () => {
    const service = { listDuplicateFormats: vi.fn().mockResolvedValue({ items: [], total: 0, page: 2, pageSize: 20 }) };
    const controller = new LibraryIntegrityController(service as never);
    const user = { id: 9 } as never;

    await controller.listDuplicateFormats({ page: 2, pageSize: 20 }, user);

    expect(service.listDuplicateFormats).toHaveBeenCalledWith(user, 2, 20);
  });
});
