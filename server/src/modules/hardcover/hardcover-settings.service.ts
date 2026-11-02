import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import type {
  HardcoverBookSyncMode,
  HardcoverList,
  HardcoverListsResult,
  HardcoverShelf,
  HardcoverShelvesResult,
  HardcoverSettings,
  HardcoverSyncDisabledReason,
  HardcoverTokenValidationResult,
  UpsertHardcoverSettingsPayload,
} from '@bookorbit/types';
import { HARDCOVER_SHELF_IDS } from '@bookorbit/types';

import { sanitizeLogValue } from '../../common/utils/log-sanitize.utils';
import { HARDCOVER_PRIVACY } from './hardcover.constants';
import { HardcoverClientService } from './hardcover-client.service';
import { HardcoverRepository } from './hardcover.repository';

const VALID_PRIVACY_IDS = [HARDCOVER_PRIVACY.PUBLIC, HARDCOVER_PRIVACY.FOLLOWS, HARDCOVER_PRIVACY.PRIVATE];
const VALID_BOOK_SYNC_MODES = ['all_eligible', 'selected_only'] as const;
const isHardcoverShelfId = (id: string): id is (typeof HARDCOVER_SHELF_IDS)[number] => (HARDCOVER_SHELF_IDS as readonly string[]).includes(id);
const HARDCOVER_SHELVES: HardcoverShelf[] = [
  { id: 'want_to_read', name: 'Want to Read' },
  { id: 'currently_reading', name: 'Currently Reading' },
  { id: 'read', name: 'Read' },
  { id: 'paused', name: 'Paused' },
  { id: 'did_not_finish', name: 'Did Not Finish' },
  { id: 'ignored', name: 'Ignored' },
];

@Injectable()
export class HardcoverSettingsService {
  private readonly logger = new Logger(HardcoverSettingsService.name);

  constructor(
    private readonly repo: HardcoverRepository,
    private readonly client: HardcoverClientService,
  ) {}

  async getSettings(userId: number): Promise<HardcoverSettings> {
    const [row, hasSyncPermission] = await Promise.all([this.repo.findSettings(userId), this.repo.userHasHardcoverSyncPermission(userId)]);
    const tokenConfigured = Boolean(row?.apiToken);
    const enabled = row?.enabled ?? false;

    return {
      tokenConfigured,
      enabled,
      effectiveEnabled: hasSyncPermission && tokenConfigured && enabled,
      disabledReason: this.resolveDisabledReason({ hasSyncPermission, tokenConfigured, enabled }),
      bookSyncMode: (row?.bookSyncMode ?? 'all_eligible') as HardcoverBookSyncMode,
      hardcoverShelfIds: (row?.hardcoverShelfIds ?? []).filter(isHardcoverShelfId),
      hardcoverListIds: row?.hardcoverListIds ?? [],
      autoSyncOnStatusChange: row?.autoSyncOnStatusChange ?? true,
      autoSyncOnProgressUpdate: row?.autoSyncOnProgressUpdate ?? true,
      autoSyncOnRatingChange: row?.autoSyncOnRatingChange ?? true,
      privacySettingId: row?.privacySettingId ?? HARDCOVER_PRIVACY.PRIVATE,
      lastSyncedAt: row?.lastSyncedAt?.toISOString() ?? null,
    };
  }

  async upsertSettings(userId: number, payload: UpsertHardcoverSettingsPayload): Promise<HardcoverSettings> {
    if (payload.privacySettingId !== undefined && !VALID_PRIVACY_IDS.includes(payload.privacySettingId as 1 | 2 | 3)) {
      throw new BadRequestException(`Invalid privacySettingId: ${payload.privacySettingId}`);
    }
    if (payload.bookSyncMode !== undefined && !VALID_BOOK_SYNC_MODES.includes(payload.bookSyncMode)) {
      throw new BadRequestException(`Invalid bookSyncMode: ${payload.bookSyncMode}`);
    }
    if (
      payload.hardcoverShelfIds !== undefined &&
      (!Array.isArray(payload.hardcoverShelfIds) ||
        payload.hardcoverShelfIds.some((id) => !HARDCOVER_SHELF_IDS.includes(id)) ||
        new Set(payload.hardcoverShelfIds).size !== payload.hardcoverShelfIds.length)
    ) {
      throw new BadRequestException('Invalid Hardcover shelf IDs');
    }
    if (
      payload.hardcoverListIds !== undefined &&
      (!Array.isArray(payload.hardcoverListIds) ||
        payload.hardcoverListIds.some((id) => !Number.isInteger(id) || id < 1) ||
        new Set(payload.hardcoverListIds).size !== payload.hardcoverListIds.length)
    ) {
      throw new BadRequestException('Invalid Hardcover list IDs');
    }

    const existing = await this.repo.findSettings(userId);

    const rawToken = payload.apiToken !== undefined ? this.stripBearerPrefix(payload.apiToken.trim()) : undefined;

    if (!existing && !rawToken) {
      throw new BadRequestException('API token is required to connect Hardcover');
    }

    const data: Parameters<typeof this.repo.upsertSettings>[1] = {};
    // Always carry a token into the INSERT side so the NOT NULL constraint is satisfied.
    // PostgreSQL checks NOT NULL before ON CONFLICT, so even on a conflict-update path
    // the INSERT values must be valid.
    data.apiToken = rawToken ?? existing!.apiToken;
    if (payload.enabled !== undefined) data.enabled = payload.enabled;
    if (payload.bookSyncMode !== undefined) data.bookSyncMode = payload.bookSyncMode;
    if (payload.hardcoverShelfIds !== undefined) data.hardcoverShelfIds = payload.hardcoverShelfIds;
    if (payload.hardcoverListIds !== undefined) data.hardcoverListIds = payload.hardcoverListIds;
    if (payload.autoSyncOnStatusChange !== undefined) data.autoSyncOnStatusChange = payload.autoSyncOnStatusChange;
    if (payload.autoSyncOnProgressUpdate !== undefined) data.autoSyncOnProgressUpdate = payload.autoSyncOnProgressUpdate;
    if (payload.autoSyncOnRatingChange !== undefined) data.autoSyncOnRatingChange = payload.autoSyncOnRatingChange;
    if (payload.privacySettingId !== undefined) data.privacySettingId = payload.privacySettingId;

    await this.repo.upsertSettings(userId, data);
    return this.getSettings(userId);
  }

  async disconnectUser(userId: number): Promise<void> {
    const existing = await this.repo.findSettings(userId);
    if (!existing) throw new NotFoundException('Hardcover integration not configured');
    await this.repo.deleteSettings(userId);
    this.logger.log(`[hardcover.disconnect] [end] userId=${userId} - user disconnected`);
  }

  async validateToken(userId: number, token?: string): Promise<HardcoverTokenValidationResult> {
    let resolvedToken = this.stripBearerPrefix(token?.trim());
    if (!resolvedToken) {
      const settings = await this.repo.findSettings(userId);
      if (!settings) return { valid: false };
      resolvedToken = settings.apiToken;
    }

    try {
      const data = await this.client.query<{ me: { username: string }[] }>(userId, resolvedToken, `query { me { username } }`);
      const username = data.me?.[0]?.username;
      if (!username) return { valid: false };
      return { valid: true, hardcoverUsername: username };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[hardcover.validate_token] [fail] userId=${userId} error="${error}" - token validation failed`);
      return { valid: false };
    }
  }

  getUserShelves(): HardcoverShelvesResult {
    return { shelves: HARDCOVER_SHELVES };
  }

  async getUserLists(userId: number, token?: string): Promise<HardcoverListsResult> {
    const resolvedToken = this.stripBearerPrefix(token?.trim()) || (await this.repo.findSettings(userId))?.apiToken;
    if (!resolvedToken) throw new BadRequestException('Hardcover API token is required to fetch lists');

    try {
      const currentUser = await this.client.query<{ me?: Array<{ id?: number | null }> }>(
        userId,
        resolvedToken,
        'query CurrentHardcoverUser { me { id } }',
      );
      const hardcoverUserId = currentUser.me?.[0]?.id;
      if (hardcoverUserId == null || !Number.isInteger(hardcoverUserId) || hardcoverUserId < 1) {
        throw new Error('Hardcover current user ID was missing');
      }

      const result = await this.client.query<{ lists?: Array<{ id: number; name: string; books_count: number | null }> }>(
        userId,
        resolvedToken,
        `query GetUserLists($userId: Int!) {
          lists(where: { user_id: { _eq: $userId } }, order_by: { updated_at: desc }) {
            id
            name
            books_count
          }
        }`,
        { userId: hardcoverUserId },
      );
      return {
        lists: (result.lists ?? []).map((list): HardcoverList => ({
          id: list.id,
          name: list.name,
          booksCount: list.books_count ?? 0,
        })),
      };
    } catch (err) {
      const error = sanitizeLogValue(err instanceof Error ? err.message : String(err));
      this.logger.warn(`[hardcover.lists] [fail] userId=${userId} error="${error}" - Hardcover lists fetch failed`);
      throw new BadRequestException('Failed to fetch Hardcover lists. Verify the token has read:lists access.');
    }
  }

  async getTokenForUser(userId: number): Promise<string | null> {
    const [settings, hasSyncPermission] = await Promise.all([this.repo.findSettings(userId), this.repo.userHasHardcoverSyncPermission(userId)]);
    if (!hasSyncPermission) return null;
    if (!settings || !settings.enabled) return null;
    return settings.apiToken;
  }

  async getMetadataToken(userId?: number, libraryId?: number): Promise<string | null> {
    const resolvedUserId = userId ?? (libraryId !== undefined ? await this.repo.findUniqueLibraryOwnerUserId(libraryId) : null);
    if (resolvedUserId === null || resolvedUserId === undefined) return null;
    const settings = await this.repo.findSettings(resolvedUserId);
    return settings?.apiToken ?? null;
  }

  private stripBearerPrefix(token: string | undefined): string | undefined {
    if (!token) return token;
    const lower = token.toLowerCase();
    return lower.startsWith('bearer ') ? token.slice(7).trim() : token;
  }

  private resolveDisabledReason(input: {
    hasSyncPermission: boolean;
    tokenConfigured: boolean;
    enabled: boolean;
  }): HardcoverSyncDisabledReason | null {
    if (!input.hasSyncPermission) return 'permission_denied';
    if (!input.tokenConfigured) return 'missing_token';
    if (!input.enabled) return 'user_disabled';
    return null;
  }
}
