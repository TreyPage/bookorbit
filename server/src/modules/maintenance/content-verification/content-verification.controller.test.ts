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

  it('delegates correction preview with the current user and validated destination', async () => {
    const preview = { fileId: 44, destinationType: 'new_book', requiresApproval: true };
    const service = { previewCorrection: vi.fn().mockResolvedValue(preview) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;
    const dto = { targetType: 'new_book' as const, title: 'The New Book', author: 'A. Writer' };

    await expect(controller.previewCorrection(44, dto, user)).resolves.toEqual(preview);
    expect(service.previewCorrection).toHaveBeenCalledWith(user, 44, dto);
  });



  it('delegates correction destination search with the current user', async () => {
    const targets = [{ bookId: 88, title: 'The New Book' }];
    const service = { searchCorrectionTargets: vi.fn().mockResolvedValue(targets) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;

    await expect(controller.searchCorrectionTargets(44, 'new', user)).resolves.toEqual(targets);
    expect(service.searchCorrectionTargets).toHaveBeenCalledWith(user, 44, 'new');
  });

  it('delegates approved file correction with the current user', async () => {
    const result = { fileId: 44, destinationBookId: 88 };
    const service = { executeCorrection: vi.fn().mockResolvedValue(result) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;
    const dto = { targetType: 'new_book' as const, title: 'The New Book', author: 'A. Writer' };

    await expect(controller.executeCorrection(44, dto, user)).resolves.toEqual(result);
    expect(service.executeCorrection).toHaveBeenCalledWith(user, 44, dto);
  });

  it('delegates manual verification with the current user', async () => {
    const service = { verifyFile: vi.fn().mockResolvedValue({ status: 'inconclusive' }) };
    const controller = new ContentVerificationController(service as never, {} as never);
    const user = { id: 12 } as never;

    await expect(controller.verifyFile(44, user)).resolves.toEqual({ status: 'inconclusive' });
    expect(service.verifyFile).toHaveBeenCalledWith(user, 44);
  });
});
