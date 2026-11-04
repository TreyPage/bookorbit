import { MetadataProviderKey, Permission } from '@bookorbit/types';
import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import type { RequestUser } from '../../common/types/request-user';
import { HardcoverSettingsService } from '../hardcover/hardcover-settings.service';
import { UpdateProviderConfigDto } from './dto/update-provider-config.dto';
import { ProviderConfigService } from './provider-config.service';

const KNOWN_PROVIDER_KEYS = new Set<MetadataProviderKey>(Object.values(MetadataProviderKey));

function parseProviderKey(value: string): MetadataProviderKey {
  if (KNOWN_PROVIDER_KEYS.has(value as MetadataProviderKey)) return value as MetadataProviderKey;
  throw new BadRequestException(`Unknown provider key: ${value}`);
}

@Controller('metadata-preferences/providers')
@RequirePermission(Permission.ManageMetadataConfig)
export class ProviderConfigController {
  constructor(
    private readonly service: ProviderConfigService,
    private readonly hardcoverSettings: HardcoverSettingsService,
  ) {}

  @Get()
  async getConfig(@CurrentUser() user: RequestUser) {
    const [config, hardcoverSettings] = await Promise.all([this.service.getConfig(), this.hardcoverSettings.getSettings(user.id)]);
    const statuses = await this.service.getProviderStatuses(config);
    const currentUserStatuses = statuses.map((status) =>
      status.key === MetadataProviderKey.HARDCOVER
        ? {
            ...status,
            configured: hardcoverSettings.tokenConfigured,
            hint: hardcoverSettings.tokenConfigured ? undefined : 'API key required. Run Test and save before enabling.',
          }
        : status,
    );
    return { config, statuses: currentUserStatuses };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  async updateConfig(@Body() dto: UpdateProviderConfigDto, @CurrentUser() user: RequestUser) {
    const current = await this.service.getConfig();
    const token = dto.hardcover?.apiKey?.trim();
    const isEnablingHardcover = dto.hardcover?.enabled === true && !current.hardcover.enabled;
    if (token || isEnablingHardcover) {
      const validation = await this.hardcoverSettings.validateToken(user.id, token);
      if (!validation.valid) {
        throw new BadRequestException(
          isEnablingHardcover ? 'A valid personal Hardcover API key is required to enable the provider.' : 'Hardcover API key is invalid.',
        );
      }
    }

    const patch: UpdateProviderConfigDto = {
      ...dto,
      ...(dto.hardcover ? { hardcover: { enabled: dto.hardcover.enabled } } : {}),
    };
    const updated = await this.service.updateConfig(patch);
    if (token) await this.hardcoverSettings.upsertSettings(user.id, { apiToken: token });
    return updated;
  }

  @Post(':key/test')
  @HttpCode(HttpStatus.OK)
  async testProvider(@Param('key') key: string, @Body() dto: UpdateProviderConfigDto = {}, @CurrentUser() user: RequestUser) {
    const providerKey = parseProviderKey(key);
    if (providerKey === MetadataProviderKey.HARDCOVER) {
      const validation = await this.hardcoverSettings.validateToken(user.id, dto.hardcover?.apiKey);
      return {
        key: providerKey,
        ok: validation.valid,
        status: validation.valid ? 'success' : 'fail',
        message: validation.valid ? `Connected as ${validation.hardcoverUsername}.` : 'Hardcover API key is invalid.',
      };
    }
    return this.service.testProvider(providerKey, dto);
  }
}
