import { BadRequestException } from '@nestjs/common';
import { MetadataProviderKey } from '@bookorbit/types';
import type { Mocked } from 'vitest';

import type { RequestUser } from '../../common/types/request-user';
import { HardcoverSettingsService } from '../hardcover/hardcover-settings.service';
import { ProviderConfigController } from './provider-config.controller';
import { ProviderConfigService } from './provider-config.service';

describe('ProviderConfigController', () => {
  let service: Mocked<ProviderConfigService>;
  let hardcoverSettings: Mocked<HardcoverSettingsService>;
  let controller: ProviderConfigController;
  const user = { id: 8 } as RequestUser;

  beforeEach(() => {
    service = {
      getConfig: vi.fn(),
      getProviderStatuses: vi.fn(),
      updateConfig: vi.fn(),
      testProvider: vi.fn(),
    } as unknown as Mocked<ProviderConfigService>;
    hardcoverSettings = {
      getSettings: vi.fn().mockResolvedValue({ tokenConfigured: false }),
      validateToken: vi.fn(),
      upsertSettings: vi.fn(),
    } as unknown as Mocked<HardcoverSettingsService>;
    controller = new ProviderConfigController(service, hardcoverSettings);
  });

  it('returns provider config and personal Hardcover connection status', async () => {
    const config = {
      google: { enabled: true, apiKey: 'key' },
      amazon: { enabled: true, domain: 'amazon.com', cookie: '' },
      goodreads: { enabled: true },
      hardcover: { enabled: false, apiKey: '' },
      openLibrary: { enabled: true },
    };
    const statuses = [
      { key: MetadataProviderKey.GOOGLE, enabled: true, configured: true, label: 'Google Books' },
      { key: MetadataProviderKey.HARDCOVER, enabled: false, configured: true, label: 'Hardcover' },
    ];
    service.getConfig.mockResolvedValue(config as never);
    service.getProviderStatuses.mockResolvedValue(statuses as never);

    const result = await controller.getConfig(user);

    expect(service.getProviderStatuses).toHaveBeenCalledWith(config);
    expect(hardcoverSettings.getSettings).toHaveBeenCalledWith(user.id);
    expect(result).toEqual({
      config,
      statuses: [statuses[0], { ...statuses[1], configured: false, hint: 'API key required. Run Test and save before enabling.' }],
    });
  });

  it('delegates non-Hardcover config updates', async () => {
    const patch = {
      google: { enabled: false },
      amazon: { cookie: 'session' },
    };
    service.getConfig.mockResolvedValue({ hardcover: { enabled: false } } as never);
    service.updateConfig.mockResolvedValue({} as never);

    await controller.updateConfig(patch as never, user);

    expect(service.updateConfig).toHaveBeenCalledWith(patch);
  });

  it('validates Hardcover tests using the current user token', async () => {
    const patch = { hardcover: { apiKey: 'personal-key' } };
    hardcoverSettings.validateToken.mockResolvedValue({ valid: true, hardcoverUsername: 'reader' });

    await expect(controller.testProvider('hardcover', patch as never, user)).resolves.toEqual({
      key: MetadataProviderKey.HARDCOVER,
      ok: true,
      status: 'success',
      message: 'Connected as reader.',
    });
    expect(hardcoverSettings.validateToken).toHaveBeenCalledWith(user.id, 'personal-key');
    expect(service.testProvider).not.toHaveBeenCalled();
  });

  it('stores a valid Hardcover key from metadata settings in the shared user settings', async () => {
    const config = { hardcover: { enabled: false } };
    service.getConfig.mockResolvedValue(config as never);
    service.updateConfig.mockResolvedValue(config as never);
    hardcoverSettings.validateToken.mockResolvedValue({ valid: true, hardcoverUsername: 'reader' });

    await controller.updateConfig({ hardcover: { apiKey: 'personal-key' } } as never, user);

    expect(service.updateConfig).toHaveBeenCalledWith({ hardcover: { enabled: undefined } });
    expect(hardcoverSettings.upsertSettings).toHaveBeenCalledWith(user.id, { apiToken: 'personal-key' });
  });

  it('rejects enabling Hardcover without a valid per-user key', async () => {
    service.getConfig.mockResolvedValue({ hardcover: { enabled: false } } as never);
    hardcoverSettings.validateToken.mockResolvedValue({ valid: false });

    await expect(controller.updateConfig({ hardcover: { enabled: true } } as never, user)).rejects.toThrow(
      'A valid personal Hardcover API key is required to enable the provider.',
    );
    expect(service.updateConfig).not.toHaveBeenCalled();
  });

  it('enables the global provider only after validating the current user token', async () => {
    const config = { hardcover: { enabled: true } };
    service.getConfig.mockResolvedValue({ hardcover: { enabled: false } } as never);
    service.updateConfig.mockResolvedValue(config as never);
    hardcoverSettings.validateToken.mockResolvedValue({ valid: true, hardcoverUsername: 'reader' });

    await controller.updateConfig({ hardcover: { enabled: true, apiKey: 'personal-key' } } as never, user);

    expect(hardcoverSettings.validateToken).toHaveBeenCalledWith(user.id, 'personal-key');
    expect(service.updateConfig).toHaveBeenCalledWith({ hardcover: { enabled: true } });
    expect(hardcoverSettings.upsertSettings).toHaveBeenCalledWith(user.id, { apiToken: 'personal-key' });
  });

  it('rejects unknown provider keys for test requests', async () => {
    await expect(controller.testProvider('unknown-provider', {} as never, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(service.testProvider).not.toHaveBeenCalled();
  });
});
