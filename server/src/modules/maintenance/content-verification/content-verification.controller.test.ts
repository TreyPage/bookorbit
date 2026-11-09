import { Permission } from '@bookorbit/types';
import { describe, expect, it, vi } from 'vitest';

import { PERMISSION_KEY } from '../../../common/decorators/require-permission.decorator';
import { ContentVerificationController } from './content-verification.controller';

describe('ContentVerificationController', () => {
  it('requires download permission and delegates result lookup', async () => {
    expect(Reflect.getMetadata(PERMISSION_KEY, ContentVerificationController)).toBe(Permission.LibraryDownload);
    const service = { getResult: vi.fn().mockResolvedValue({ status: 'match' }) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;

    await expect(controller.getResult(44, user)).resolves.toEqual({ status: 'match' });
    expect(service.getResult).toHaveBeenCalledWith(user, 44);
  });

  it('delegates review decisions with the current user', async () => {
    const service = { reviewFile: vi.fn().mockResolvedValue({ reviewStatus: 'confirmed_mismatch' }) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;
    const dto = { reviewStatus: 'confirmed_mismatch' as const, reviewNote: 'Wrong title' };

    await expect(controller.reviewFile(44, dto, user)).resolves.toEqual({ reviewStatus: 'confirmed_mismatch' });
    expect(service.reviewFile).toHaveBeenCalledWith(user, 44, 'confirmed_mismatch', 'Wrong title');
  });

  it('delegates manual verification with the current user', async () => {
    const service = { verifyFile: vi.fn().mockResolvedValue({ status: 'inconclusive' }) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;

    await expect(controller.verifyFile(44, user)).resolves.toEqual({ status: 'inconclusive' });
    expect(service.verifyFile).toHaveBeenCalledWith(user, 44);
  });
});
