import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { HardcoverSettingsService } from './hardcover-settings.service';

const mockRepo = {
  findSettings: vi.fn(),
  findUniqueLibraryOwnerUserId: vi.fn(),
  userHasHardcoverSyncPermission: vi.fn(),
  upsertSettings: vi.fn(),
  deleteSettings: vi.fn(),
};

const mockClient = {
  query: vi.fn(),
};

function makeService() {
  return new HardcoverSettingsService(mockRepo as any, mockClient as any);
}

describe('HardcoverSettingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRepo.userHasHardcoverSyncPermission.mockResolvedValue(true);
  });

  describe('getSettings', () => {
    it('returns defaults when no settings row exists', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      const result = await makeService().getSettings(1);
      expect(result.tokenConfigured).toBe(false);
      expect(result.enabled).toBe(false);
      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('missing_token');
      expect(result.bookSyncMode).toBe('all_eligible');
      expect(result.hardcoverShelfIds).toEqual([]);
      expect(result.hardcoverListIds).toEqual([]);
      expect(result.privacySettingId).toBe(3);
    });

    it('returns settings without token when row exists', async () => {
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'secret',
        enabled: true,
        bookSyncMode: 'selected_only',
        hardcoverShelfIds: ['read'],
        hardcoverListIds: [17],
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: false,
        autoSyncOnRatingChange: true,
        privacySettingId: 1,
        lastSyncedAt: null,
      });
      const result = await makeService().getSettings(1);
      expect(result.tokenConfigured).toBe(true);
      expect(result.enabled).toBe(true);
      expect(result.effectiveEnabled).toBe(true);
      expect(result.disabledReason).toBeNull();
      expect(result.bookSyncMode).toBe('selected_only');
      expect(result.hardcoverShelfIds).toEqual(['read']);
      expect(result.hardcoverListIds).toEqual([17]);
      expect(result.autoSyncOnProgressUpdate).toBe(false);
      expect((result as any).apiToken).toBeUndefined();
      expect(result.lastSyncedAt).toBeNull();
    });

    it('returns user disabled effective state when configured sync is paused', async () => {
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'secret',
        enabled: false,
        bookSyncMode: 'all_eligible',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: true,
        autoSyncOnRatingChange: true,
        privacySettingId: 3,
        lastSyncedAt: null,
      });

      const result = await makeService().getSettings(1);

      expect(result.enabled).toBe(false);
      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('user_disabled');
    });

    it('returns permission denied effective state when the user lacks Hardcover sync permission', async () => {
      mockRepo.userHasHardcoverSyncPermission.mockResolvedValue(false);
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'secret',
        enabled: true,
        bookSyncMode: 'all_eligible',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: true,
        autoSyncOnRatingChange: true,
        privacySettingId: 3,
        lastSyncedAt: null,
      });

      const result = await makeService().getSettings(1);

      expect(result.effectiveEnabled).toBe(false);
      expect(result.disabledReason).toBe('permission_denied');
    });

    it('returns lastSyncedAt as ISO string when set', async () => {
      const syncedAt = new Date('2025-05-01T10:00:00Z');
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'secret',
        enabled: true,
        bookSyncMode: 'all_eligible',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: true,
        autoSyncOnRatingChange: true,
        privacySettingId: 3,
        lastSyncedAt: syncedAt,
      });
      const result = await makeService().getSettings(1);
      expect(result.lastSyncedAt).toBe(syncedAt.toISOString());
    });

    it('returns null lastSyncedAt when no settings row exists', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      const result = await makeService().getSettings(1);
      expect(result.tokenConfigured).toBe(false);
      expect(result.lastSyncedAt).toBeNull();
    });
  });

  describe('getMetadataToken', () => {
    it('returns the current user token independent of sync enablement or permission', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'personal-token', enabled: false });
      mockRepo.userHasHardcoverSyncPermission.mockResolvedValue(false);

      await expect(makeService().getMetadataToken(7)).resolves.toBe('personal-token');
      expect(mockRepo.findSettings).toHaveBeenCalledWith(7);
      expect(mockRepo.userHasHardcoverSyncPermission).not.toHaveBeenCalled();
    });

    it('uses the unique library owner token for background metadata jobs', async () => {
      mockRepo.findUniqueLibraryOwnerUserId.mockResolvedValue(12);
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'owner-token' });

      await expect(makeService().getMetadataToken(undefined, 4)).resolves.toBe('owner-token');
      expect(mockRepo.findUniqueLibraryOwnerUserId).toHaveBeenCalledWith(4);
      expect(mockRepo.findSettings).toHaveBeenCalledWith(12);
    });

    it('does not choose a token when the library has no unique owner', async () => {
      mockRepo.findUniqueLibraryOwnerUserId.mockResolvedValue(null);

      await expect(makeService().getMetadataToken(undefined, 4)).resolves.toBeNull();
      expect(mockRepo.findSettings).not.toHaveBeenCalled();
    });
  });

  describe('upsertSettings', () => {
    it('throws BadRequestException for invalid privacySettingId', async () => {
      await expect(makeService().upsertSettings(1, { privacySettingId: 99 })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when setting empty token without existing settings', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      await expect(makeService().upsertSettings(1, { apiToken: '   ' })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when saving settings without token and no existing row', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      await expect(makeService().upsertSettings(1, { enabled: true })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for invalid bookSyncMode', async () => {
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'token',
        enabled: true,
        bookSyncMode: 'all_eligible',
      });

      await expect(makeService().upsertSettings(1, { bookSyncMode: 'invalid' as never })).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for invalid selected Hardcover shelf IDs', async () => {
      await expect(makeService().upsertSettings(1, { hardcoverShelfIds: ['read', 'read'] })).rejects.toThrow(BadRequestException);
      expect(mockRepo.findSettings).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for invalid selected Hardcover list IDs', async () => {
      await expect(makeService().upsertSettings(1, { hardcoverListIds: [17, 17] })).rejects.toThrow(BadRequestException);
      await expect(makeService().upsertSettings(1, { hardcoverListIds: [0] })).rejects.toThrow(BadRequestException);
      expect(mockRepo.findSettings).not.toHaveBeenCalled();
    });

    it('upserts and returns settings', async () => {
      mockRepo.findSettings.mockResolvedValueOnce(undefined).mockResolvedValue({
        apiToken: 'token',
        enabled: true,
        bookSyncMode: 'selected_only',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: true,
        autoSyncOnRatingChange: true,
        privacySettingId: 3,
      });
      mockRepo.upsertSettings.mockResolvedValue({});
      const result = await makeService().upsertSettings(1, { apiToken: 'token', bookSyncMode: 'selected_only' });
      expect(result.tokenConfigured).toBe(true);
      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, { apiToken: 'token', bookSyncMode: 'selected_only' });
    });

    it('carries existing token forward when updating settings without a new token', async () => {
      const existing = {
        apiToken: 'saved-token',
        enabled: true,
        bookSyncMode: 'all_eligible',
        autoSyncOnStatusChange: true,
        autoSyncOnProgressUpdate: true,
        autoSyncOnRatingChange: true,
        privacySettingId: 3,
      };
      mockRepo.findSettings.mockResolvedValue(existing);
      mockRepo.upsertSettings.mockResolvedValue({});
      await makeService().upsertSettings(1, { enabled: false });
      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, {
        apiToken: 'saved-token',
        enabled: false,
      });
    });

    it('saves selected Hardcover shelf IDs', async () => {
      mockRepo.findSettings.mockResolvedValue({
        apiToken: 'saved-token',
        enabled: true,
        bookSyncMode: 'all_eligible',
      });
      mockRepo.upsertSettings.mockResolvedValue({});

      await makeService().upsertSettings(1, { hardcoverShelfIds: ['read'] });

      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, {
        apiToken: 'saved-token',
        hardcoverShelfIds: ['read'],
      });
    });

    it('saves selected Hardcover custom list IDs', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'saved-token', enabled: true });
      mockRepo.upsertSettings.mockResolvedValue({});

      await makeService().upsertSettings(1, { hardcoverListIds: [12, 34] });

      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, {
        apiToken: 'saved-token',
        hardcoverListIds: [12, 34],
      });
    });
  });

  describe('disconnectUser', () => {
    it('throws NotFoundException when not configured', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      await expect(makeService().disconnectUser(1)).rejects.toThrow(NotFoundException);
    });

    it('deletes settings when configured', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'token' });
      mockRepo.deleteSettings.mockResolvedValue(undefined);
      await makeService().disconnectUser(1);
      expect(mockRepo.deleteSettings).toHaveBeenCalledWith(1);
    });
  });

  describe('validateToken', () => {
    it('returns invalid when no settings', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      expect(await makeService().validateToken(1)).toEqual({ valid: false });
    });

    it('returns valid with username on success', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok' });
      mockClient.query.mockResolvedValue({ me: [{ username: 'neonsolstice' }] });
      const result = await makeService().validateToken(1);
      expect(result).toEqual({ valid: true, hardcoverUsername: 'neonsolstice' });
    });

    it('strips Bearer prefix from inline token before querying', async () => {
      mockClient.query.mockResolvedValue({ me: [{ username: 'neonsolstice' }] });
      await makeService().validateToken(1, 'Bearer myrawtoken');
      expect(mockClient.query).toHaveBeenCalledWith(1, 'myrawtoken', expect.any(String));
    });

    it('strips Bearer prefix when saving via upsertSettings', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'existing' });
      mockRepo.upsertSettings.mockResolvedValue(undefined);
      await makeService().upsertSettings(1, { apiToken: 'Bearer myrawtoken' });
      expect(mockRepo.upsertSettings).toHaveBeenCalledWith(1, expect.objectContaining({ apiToken: 'myrawtoken' }));
    });

    it('returns invalid when query throws', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok' });
      mockClient.query.mockRejectedValue(new Error('Unauthorized'));
      const result = await makeService().validateToken(1);
      expect(result).toEqual({ valid: false });
    });

    it('returns invalid when me is empty array', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok' });
      mockClient.query.mockResolvedValue({ me: [] });
      const result = await makeService().validateToken(1);
      expect(result).toEqual({ valid: false });
    });
  });

  describe('getUserShelves', () => {
    it('returns Hardcover reading-status shelves without custom lists', () => {
      expect(makeService().getUserShelves()).toEqual({
        shelves: [
          { id: 'want_to_read', name: 'Want to Read' },
          { id: 'currently_reading', name: 'Currently Reading' },
          { id: 'read', name: 'Read' },
          { id: 'paused', name: 'Paused' },
          { id: 'did_not_finish', name: 'Did Not Finish' },
          { id: 'ignored', name: 'Ignored' },
        ],
      });
    });

    it('loads the authenticated user’s custom lists using a supplied token', async () => {
      mockClient.query.mockResolvedValueOnce({ me: [{ id: 700 }] }).mockResolvedValueOnce({ lists: [{ id: 19, name: 'Owned', books_count: 63 }] });

      await expect(makeService().getUserLists(1, 'Bearer new-token')).resolves.toEqual({
        lists: [{ id: 19, name: 'Owned', booksCount: 63 }],
      });
      expect(mockClient.query).toHaveBeenNthCalledWith(1, 1, 'new-token', expect.stringContaining('me { id }'));
      expect(mockClient.query).toHaveBeenNthCalledWith(2, 1, 'new-token', expect.stringContaining('lists(where'), { userId: 700 });
    });

    it('loads custom lists using the saved token when no token is supplied', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'saved-token' });
      mockClient.query.mockResolvedValueOnce({ me: [{ id: 700 }] }).mockResolvedValueOnce({ lists: [] });

      await expect(makeService().getUserLists(1)).resolves.toEqual({ lists: [] });
      expect(mockClient.query).toHaveBeenCalledWith(1, 'saved-token', expect.any(String), expect.anything());
    });

    it('reports list-scope failures instead of returning an empty list', async () => {
      mockClient.query.mockRejectedValue(new Error('missing read:lists scope'));

      await expect(makeService().getUserLists(1, 'token')).rejects.toThrow('Failed to fetch Hardcover lists');
    });
  });

  describe('getTokenForUser', () => {
    it('returns null when no settings', async () => {
      mockRepo.findSettings.mockResolvedValue(undefined);
      expect(await makeService().getTokenForUser(1)).toBeNull();
    });

    it('returns null when the user lacks Hardcover sync permission', async () => {
      mockRepo.userHasHardcoverSyncPermission.mockResolvedValue(false);
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok', enabled: true });
      expect(await makeService().getTokenForUser(1)).toBeNull();
    });

    it('returns null when disabled', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok', enabled: false });
      expect(await makeService().getTokenForUser(1)).toBeNull();
    });

    it('returns token when enabled', async () => {
      mockRepo.findSettings.mockResolvedValue({ apiToken: 'tok', enabled: true });
      expect(await makeService().getTokenForUser(1)).toBe('tok');
    });
  });
});
