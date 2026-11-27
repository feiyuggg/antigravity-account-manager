import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccountProfile, AccountSaveInput, AppSettings } from '../shared/types';
import { DEFAULT_ANTIGRAVITY_APP_PATH } from './antigravityApp';
import { getDefaultProfilesRootDir } from './envIsolation';

export interface StoreData {
  version: 1;
  activeAccountId: string | null;
  accounts: AccountProfile[];
  settings: AppSettings;
}

export const ACCOUNT_COLOR_PALETTE = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
];

export function isAutoPlaceholderNickname(nickname: string): boolean {
  return /^账号\s+\d+$/.test(nickname.trim());
}

export function generateNextAccountDefaults(existingAccounts: AccountProfile[]): {
  nickname: string;
  color: string;
} {
  const usedNames = new Set(existingAccounts.map((a) => a.nickname.trim()));
  let index = 1;
  while (usedNames.has(`账号 ${index}`)) {
    index++;
  }
  return {
    nickname: `账号 ${index}`,
    color: ACCOUNT_COLOR_PALETTE[existingAccounts.length % ACCOUNT_COLOR_PALETTE.length],
  };
}

export function createDefaultSettings(): AppSettings {
  return {
    agyPathOverride: '',
    antigravityAppPath: DEFAULT_ANTIGRAVITY_APP_PATH,
    profilesRootDir: getDefaultProfilesRootDir(),
    defaultAuthMode: 'oauth-personal',
    extraLaunchArgs: '',
    postRestartCommand: '',
    postRestartCommands: [],
    shareConversationsAndProjects: true,
    shareGlobalCustomizations: true,
    symlinkShellConfig: true,
    showTrayAccount: true,
    theme: 'system',
  };
}

function createDefaultStore(): StoreData {
  return {
    version: 1,
    activeAccountId: null,
    accounts: [],
    settings: createDefaultSettings(),
  };
}

/**
 * Local JSON profile store.
 * Stores strictly user profile metadata, isolation mode, and verification timestamps —
 * NEVER OAuth tokens, Keychain data, cookies, or quota/usage telemetry.
 */
export class ProfileStore {
  private readonly filePath: string;
  private data: StoreData;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.load();
  }

  private load(): StoreData {
    const defaults = createDefaultSettings();
    try {
      if (!fs.existsSync(this.filePath)) {
        return createDefaultStore();
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreData>;
      const mergedSettings: AppSettings = {
        ...defaults,
        ...(parsed.settings ?? {}),
      };
      if (
        (!Array.isArray(mergedSettings.postRestartCommands) ||
          mergedSettings.postRestartCommands.length === 0) &&
        typeof mergedSettings.postRestartCommand === 'string' &&
        mergedSettings.postRestartCommand.trim().length > 0
      ) {
        mergedSettings.postRestartCommands = [
          {
            id: crypto.randomUUID(),
            name: '重启后命令',
            command: mergedSettings.postRestartCommand.trim(),
            enabled: true,
          },
        ];
      }
      if (!Array.isArray(mergedSettings.postRestartCommands)) {
        mergedSettings.postRestartCommands = [];
      }
      return {
        version: 1,
        activeAccountId:
          typeof parsed.activeAccountId === 'string' ? parsed.activeAccountId : null,
        accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [],
        settings: mergedSettings,
      };
    } catch {
      return createDefaultStore();
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.filePath);
  }

  getState(): StoreData {
    return {
      version: 1,
      activeAccountId: this.data.activeAccountId,
      accounts: this.data.accounts.map((a) => ({ ...a })),
      settings: { ...this.data.settings },
    };
  }

  listAccounts(): AccountProfile[] {
    return this.data.accounts.map((a) => ({ ...a }));
  }

  getAccount(id: string): AccountProfile | undefined {
    return this.data.accounts.find((a) => a.id === id);
  }

  getActiveAccountId(): string | null {
    return this.data.activeAccountId;
  }

  getSettings(): AppSettings {
    return { ...this.data.settings };
  }

  upsertAccount(input: AccountSaveInput): AccountProfile {
    const nickname = input.nickname.trim();
    if (!nickname) {
      throw new Error('账号名称不能为空');
    }

    // Only one account can be bound to the shared system default environment
    if (input.isolationMode === 'system') {
      const existingSystem = this.data.accounts.find(
        (a) => a.isolationMode === 'system' && a.id !== input.id,
      );
      if (existingSystem) {
        throw new Error(
          `已存在系统默认环境账号「${existingSystem.nickname}」，其他账号请使用独立环境变量槽位`,
        );
      }
    }

    if (input.id) {
      const idx = this.data.accounts.findIndex((a) => a.id === input.id);
      if (idx !== -1) {
        const existing = this.data.accounts[idx];
        const updated: AccountProfile = {
          ...existing,
          nickname,
          emailHint: input.emailHint?.trim() || undefined,
          note: input.note?.trim() || undefined,
          color: input.color || existing.color,
          isolationMode: existing.isolationMode, // keep isolation mode immutable once created
          preferredAuthMode: input.preferredAuthMode,
        };
        this.data.accounts[idx] = updated;
        this.persist();
        return { ...updated };
      }
    }

    const created: AccountProfile = {
      id: input.id || crypto.randomUUID(),
      nickname,
      emailHint: input.emailHint?.trim() || undefined,
      note: input.note?.trim() || undefined,
      color: input.color || '#3b82f6',
      isolationMode: input.isolationMode,
      preferredAuthMode: input.preferredAuthMode,
      createdAt: new Date().toISOString(),
    };
    this.data.accounts.push(created);
    this.persist();
    return { ...created };
  }

  deleteAccount(id: string): void {
    this.data.accounts = this.data.accounts.filter((a) => a.id !== id);
    if (this.data.activeAccountId === id) {
      this.data.activeAccountId = null;
    }
    this.persist();
  }

  setActiveAccount(id: string | null): void {
    if (id !== null && !this.data.accounts.some((a) => a.id === id)) {
      throw new Error(`Account "${id}" not found`);
    }
    this.data.activeAccountId = id;
    if (id !== null) {
      const idx = this.data.accounts.findIndex((a) => a.id === id);
      if (idx !== -1) {
        this.data.accounts[idx] = {
          ...this.data.accounts[idx],
          lastSwitchedAt: new Date().toISOString(),
        };
      }
    }
    this.persist();
  }

  markVerified(id: string): void {
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return;
    this.data.accounts[idx] = {
      ...this.data.accounts[idx],
      lastVerifiedAt: new Date().toISOString(),
    };
    this.persist();
  }

  syncDetectedIdentity(id: string, email: string): AccountProfile | undefined {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return this.getAccount(id);
    const idx = this.data.accounts.findIndex((a) => a.id === id);
    if (idx === -1) return undefined;

    const existing = this.data.accounts[idx];
    let nextNickname = existing.nickname;

    if (isAutoPlaceholderNickname(existing.nickname)) {
      const localPart = trimmedEmail.split('@')[0]?.trim();
      if (localPart) {
        const localUsedElsewhere = this.data.accounts.some(
          (a) => a.id !== id && a.nickname.trim() === localPart,
        );
        nextNickname = localUsedElsewhere ? trimmedEmail : localPart;
      } else {
        nextNickname = trimmedEmail;
      }
    }

    const updated: AccountProfile = {
      ...existing,
      nickname: nextNickname,
      emailHint: trimmedEmail,
    };
    this.data.accounts[idx] = updated;
    this.persist();
    return { ...updated };
  }

  updateSettings(partial: Partial<AppSettings>): AppSettings {
    this.data.settings = {
      ...this.data.settings,
      ...partial,
    };
    this.persist();
    return { ...this.data.settings };
  }
}
