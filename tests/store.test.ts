import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_COLOR_PALETTE,
  ProfileStore,
  createDefaultSettings,
  generateNextAccountDefaults,
} from '../electron/store';

describe('ProfileStore', () => {
  it('supports CRUD, single system slot rule, active binding, and atomic persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-store-'));
    const storeFile = path.join(dir, 'profiles.json');

    try {
      const store = new ProfileStore(storeFile);
      const sysAcc = store.upsertAccount({
        nickname: '系统默认号',
        emailHint: 'main@gmail.com',
        color: '#3b82f6',
        isolationMode: 'system',
        preferredAuthMode: 'oauth-personal',
      });

      expect(() =>
        store.upsertAccount({
          nickname: '第二个系统号',
          color: '#10b981',
          isolationMode: 'system',
          preferredAuthMode: 'terminal-login',
        }),
      ).toThrow();

      const isoAcc = store.upsertAccount({
        nickname: '工作独立号',
        emailHint: 'work@gmail.com',
        color: '#10b981',
        isolationMode: 'isolated',
        preferredAuthMode: 'terminal-login',
      });

      store.setActiveAccount(isoAcc.id);
      store.markVerified(isoAcc.id);
      store.updateSettings({ shareGlobalCustomizations: false, theme: 'dark' });

      const reloaded = new ProfileStore(storeFile);
      expect(reloaded.getActiveAccountId()).toBe(isoAcc.id);
      expect(reloaded.listAccounts()).toHaveLength(2);
      expect(reloaded.getAccount(isoAcc.id)?.lastVerifiedAt).toBeTruthy();
      expect(reloaded.getAccount(isoAcc.id)?.lastSwitchedAt).toBeTruthy();
      expect(reloaded.getSettings().shareGlobalCustomizations).toBe(false);
      expect(reloaded.getSettings().theme).toBe('dark');

      reloaded.deleteAccount(isoAcc.id);
      expect(reloaded.getActiveAccountId()).toBeNull();
      expect(reloaded.listAccounts().map((a) => a.id)).toEqual([sysAcc.id]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('generates sequential account defaults, reuses gaps, and defaults to oauth-personal', () => {
    const defaults = createDefaultSettings();
    expect(defaults.defaultAuthMode).toBe('oauth-personal');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-defaults-'));
    const store = new ProfileStore(path.join(dir, 'profiles.json'));
    try {
      const firstDefaults = generateNextAccountDefaults(store.listAccounts());
      expect(firstDefaults.nickname).toBe('账号 1');
      expect(firstDefaults.color).toBe(ACCOUNT_COLOR_PALETTE[0]);

      const a1 = store.upsertAccount({
        nickname: firstDefaults.nickname,
        color: firstDefaults.color,
        isolationMode: 'isolated',
        preferredAuthMode: 'oauth-personal',
      });

      const secondDefaults = generateNextAccountDefaults(store.listAccounts());
      expect(secondDefaults.nickname).toBe('账号 2');
      expect(secondDefaults.color).toBe(ACCOUNT_COLOR_PALETTE[1]);

      const a2 = store.upsertAccount({
        nickname: secondDefaults.nickname,
        color: secondDefaults.color,
        isolationMode: 'isolated',
        preferredAuthMode: 'oauth-personal',
      });

      store.deleteAccount(a1.id);
      const gapDefaults = generateNextAccountDefaults(store.listAccounts());
      expect(gapDefaults.nickname).toBe('账号 1');
      expect(a2.nickname).toBe('账号 2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto-fills emailHint and upgrades placeholder nicknames via syncDetectedIdentity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-sync-id-'));
    const store = new ProfileStore(path.join(dir, 'profiles.json'));
    try {
      const slot1 = store.upsertAccount({
        nickname: '账号 1',
        color: '#3b82f6',
        isolationMode: 'isolated',
        preferredAuthMode: 'oauth-personal',
      });
      const slot2 = store.upsertAccount({
        nickname: '账号 2',
        color: '#10b981',
        isolationMode: 'isolated',
        preferredAuthMode: 'oauth-personal',
      });
      const customSlot = store.upsertAccount({
        nickname: '主力大号',
        color: '#8b5cf6',
        isolationMode: 'isolated',
        preferredAuthMode: 'oauth-personal',
      });

      const updated1 = store.syncDetectedIdentity(slot1.id, 'alice@gmail.com');
      expect(updated1?.emailHint).toBe('alice@gmail.com');
      expect(updated1?.nickname).toBe('alice');

      // Duplicate localPart 'alice' should fall back to full email for slot2
      const updated2 = store.syncDetectedIdentity(slot2.id, 'alice@work.com');
      expect(updated2?.emailHint).toBe('alice@work.com');
      expect(updated2?.nickname).toBe('alice@work.com');

      // Custom nickname should be preserved while emailHint is populated
      const updatedCustom = store.syncDetectedIdentity(customSlot.id, 'vip@gmail.com');
      expect(updatedCustom?.emailHint).toBe('vip@gmail.com');
      expect(updatedCustom?.nickname).toBe('主力大号');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates legacy postRestartCommand into postRestartCommands on load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-migrate-cmd-'));
    const storeFile = path.join(dir, 'profiles.json');
    try {
      fs.writeFileSync(
        storeFile,
        JSON.stringify({
          version: 1,
          activeAccountId: null,
          accounts: [],
          settings: {
            postRestartCommand: 'node /tmp/plugin/cli.js live',
          },
        }),
        'utf8',
      );
      const loaded = new ProfileStore(storeFile);
      expect(loaded.getSettings().postRestartCommands).toHaveLength(1);
      expect(loaded.getSettings().postRestartCommands[0].command).toBe(
        'node /tmp/plugin/cli.js live',
      );
      expect(loaded.getSettings().postRestartCommands[0].enabled).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
