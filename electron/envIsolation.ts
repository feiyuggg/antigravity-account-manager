import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AccountProfile, AuditEntry } from '../shared/types';
import { buildBaseEnv } from './acp/binary';

const execFileAsync = promisify(execFile);

export type AuditSink = (entry: AuditEntry) => void;

const SHELL_DOTFILES_TO_LINK = [
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.gitconfig',
  '.gitignore_global',
  '.ssh',
  '.local',
  '.npmrc',
];

const GEMINI_CONFIG_ITEMS_TO_SHARE = ['skills', 'plugins', 'rules'];

const ANTIGRAVITY_SHARED_DATA_DIRS = [
  'conversations',
  'conversations_archive',
  'brain',
  'annotations',
  'scratch',
  'knowledge',
];

const DERIVED_SUMMARY_CACHE_FILES = [
  'conversation_summaries.db',
  'conversation_summaries.db-shm',
  'conversation_summaries.db-wal',
  'agyhub_summaries_proto.pb',
];

export function getDefaultProfilesRootDir(realHome = os.homedir()): string {
  return path.join(realHome, '.antigravity-accounts', 'profiles');
}

function sanitizeProfileId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || 'default-profile';
}

function canonicalizeDir(dirPath: string): string {
  try {
    return fs.realpathSync(dirPath);
  } catch {
    const parent = path.dirname(dirPath);
    if (parent && parent !== dirPath) {
      try {
        return path.join(fs.realpathSync(parent), path.basename(dirPath));
      } catch {
        return dirPath;
      }
    }
    return dirPath;
  }
}

export function getProfileHomeDir(
  account: Pick<AccountProfile, 'id' | 'isolationMode'>,
  profilesRootDir: string,
  realHome = os.homedir(),
): string {
  if (account.isolationMode === 'system') {
    return canonicalizeDir(realHome);
  }
  const safeId = sanitizeProfileId(account.id);
  return canonicalizeDir(path.join(profilesRootDir, safeId));
}

export interface BuiltProfileEnv {
  profileHome: string;
  env: NodeJS.ProcessEnv;
  envPreview: Record<string, string>;
}

/**
 * Construct isolated environment variables for an account slot.
 * Setting BOTH `HOME` and `CFFIXED_USER_HOME` guarantees Electron (`userData`),
 * macOS `Security.framework` (Keychain), `cfprefsd`, and Go (`agy`) all resolve
 * inside `profileHome` without touching the user's real `$HOME` or Keychain.
 */
export function buildProfileEnv(
  account: Pick<AccountProfile, 'id' | 'isolationMode'>,
  options: {
    profilesRootDir: string;
    realHome?: string;
    baseEnv?: NodeJS.ProcessEnv;
  },
): BuiltProfileEnv {
  const realHome = canonicalizeDir(options.realHome ?? os.homedir());
  const baseEnv = options.baseEnv ?? buildBaseEnv();
  const profileHome = getProfileHomeDir(account, options.profilesRootDir, realHome);

  if (account.isolationMode === 'system') {
    const envPreview: Record<string, string> = {
      HOME: realHome,
      CFFIXED_USER_HOME: realHome,
      AGY_PROFILE_ID: account.id,
      AGY_PROFILE_MODE: 'system',
    };
    return {
      profileHome: realHome,
      env: {
        ...baseEnv,
        ...envPreview,
      },
      envPreview,
    };
  }

  const envPreview: Record<string, string> = {
    HOME: profileHome,
    CFFIXED_USER_HOME: profileHome,
    XDG_CONFIG_HOME: path.join(profileHome, '.config'),
    XDG_DATA_HOME: path.join(profileHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(profileHome, '.cache'),
    AGY_PROFILE_ID: account.id,
    AGY_PROFILE_MODE: 'isolated',
  };

  return {
    profileHome,
    env: {
      ...baseEnv,
      ...envPreview,
    },
    envPreview,
  };
}

function safeSymlink(targetPath: string, linkPath: string): void {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  try {
    const stat = fs.lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(linkPath);
      if (existing === targetPath) {
        return;
      }
      fs.unlinkSync(linkPath);
    } else {
      // Do not overwrite real user files/directories created in the profile
      return;
    }
  } catch {
    // linkPath does not exist yet
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(targetPath, linkPath);
}

/**
 * Link a shared directory from `realTargetDir` into `profileLinkPath`.
 * If `profileLinkPath` is already a real directory (e.g. an older isolated slot),
 * copy any unique entries back into `realTargetDir` before replacing it with a symlink.
 * Returns true if the symlink was newly created or replaced.
 */
function linkSharedDirWithMerge(realTargetDir: string, profileLinkPath: string): boolean {
  fs.mkdirSync(realTargetDir, { recursive: true });

  let stat: fs.Stats | null = null;
  try {
    stat = fs.lstatSync(profileLinkPath);
  } catch {
    stat = null;
  }

  if (stat) {
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(profileLinkPath);
      if (existing === realTargetDir) {
        return false;
      }
      fs.unlinkSync(profileLinkPath);
      fs.symlinkSync(realTargetDir, profileLinkPath);
      return true;
    }

    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(profileLinkPath)) {
        const destEntry = path.join(realTargetDir, entry);
        if (!fs.existsSync(destEntry)) {
          fs.cpSync(path.join(profileLinkPath, entry), destEntry, { recursive: true });
        }
      }
      fs.rmSync(profileLinkPath, { recursive: true, force: true });
      fs.symlinkSync(realTargetDir, profileLinkPath);
      return true;
    }

    return false;
  }

  fs.mkdirSync(path.dirname(profileLinkPath), { recursive: true });
  fs.symlinkSync(realTargetDir, profileLinkPath);
  return true;
}

function unlinkSharedDirIfSymlink(profileLinkPath: string): void {
  try {
    const stat = fs.lstatSync(profileLinkPath);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(profileLinkPath);
      fs.mkdirSync(profileLinkPath, { recursive: true });
    }
  } catch {
    // does not exist
  }
}

function linkSharedFileIfDefault(realFilePath: string, profileFilePath: string): void {
  if (!fs.existsSync(realFilePath)) {
    return;
  }

  try {
    const stat = fs.lstatSync(profileFilePath);
    if (stat.isSymbolicLink()) {
      if (fs.readlinkSync(profileFilePath) === realFilePath) {
        return;
      }
      fs.unlinkSync(profileFilePath);
      fs.symlinkSync(realFilePath, profileFilePath);
      return;
    }
    if (stat.isFile() && stat.size <= 4) {
      fs.unlinkSync(profileFilePath);
      fs.symlinkSync(realFilePath, profileFilePath);
      return;
    }
    // Preserve custom non-empty file in the profile
    return;
  } catch {
    // does not exist yet
  }

  fs.mkdirSync(path.dirname(profileFilePath), { recursive: true });
  fs.symlinkSync(realFilePath, profileFilePath);
}

/**
 * Prepare an isolated profile directory on disk:
 * - Creates `.config`, `.cache`, `Library/Keychains`, `Library/Preferences`, `Library/Application Support`
 * - Initializes an isolated `login.keychain-db` strictly under isolated `HOME` + `CFFIXED_USER_HOME`
 * - Optionally shares conversations/projects, global customizations, and developer dotfiles
 * Never symlinks `.gemini`, `.gemini/antigravity`, or `Library` as a whole, and never reads credentials.
 */
export async function ensureIsolatedProfileReady(
  account: Pick<AccountProfile, 'id' | 'nickname' | 'isolationMode'>,
  options: {
    profilesRootDir: string;
    realHome?: string;
    shareConversationsAndProjects?: boolean;
    shareGlobalCustomizations: boolean;
    symlinkShellConfig: boolean;
    onAudit?: AuditSink;
  },
): Promise<BuiltProfileEnv> {
  const realHome = canonicalizeDir(options.realHome ?? os.homedir());
  const built = buildProfileEnv(account, {
    profilesRootDir: options.profilesRootDir,
    realHome,
  });

  if (account.isolationMode === 'system') {
    return built;
  }

  const auditId = crypto.randomUUID();
  const startedAt = Date.now();
  options.onAudit?.({
    id: auditId,
    timestamp: new Date().toISOString(),
    source: 'ENV_ISOLATION',
    operation: `prepare isolated env (${account.nickname})`,
    status: 'running',
    detail: built.profileHome,
  });

  try {
    const { profileHome, env } = built;
    const antigravityDataDir = path.join(profileHome, '.gemini', 'antigravity');
    const geminiConfigDir = path.join(profileHome, '.gemini', 'config');

    fs.mkdirSync(profileHome, { recursive: true });
    fs.mkdirSync(path.join(profileHome, '.config'), { recursive: true });
    fs.mkdirSync(path.join(profileHome, '.cache'), { recursive: true });
    fs.mkdirSync(path.join(profileHome, 'Library', 'Keychains'), { recursive: true });
    fs.mkdirSync(path.join(profileHome, 'Library', 'Preferences'), { recursive: true });
    fs.mkdirSync(path.join(profileHome, 'Library', 'Application Support'), { recursive: true });
    fs.mkdirSync(geminiConfigDir, { recursive: true });
    fs.mkdirSync(antigravityDataDir, { recursive: true });

    if (options.symlinkShellConfig) {
      for (const item of SHELL_DOTFILES_TO_LINK) {
        safeSymlink(path.join(realHome, item), path.join(profileHome, item));
      }
    }

    if (options.shareGlobalCustomizations) {
      for (const item of GEMINI_CONFIG_ITEMS_TO_SHARE) {
        safeSymlink(
          path.join(realHome, '.gemini', 'config', item),
          path.join(geminiConfigDir, item),
        );
      }
    }

    if (options.shareConversationsAndProjects !== false) {
      linkSharedDirWithMerge(
        path.join(realHome, '.gemini', 'config', 'projects'),
        path.join(geminiConfigDir, 'projects'),
      );
      linkSharedFileIfDefault(
        path.join(realHome, '.gemini', 'config', 'mcp_config.json'),
        path.join(geminiConfigDir, 'mcp_config.json'),
      );

      let conversationsMigrated = false;
      for (const dirName of ANTIGRAVITY_SHARED_DATA_DIRS) {
        const migrated = linkSharedDirWithMerge(
          path.join(realHome, '.gemini', 'antigravity', dirName),
          path.join(antigravityDataDir, dirName),
        );
        if (dirName === 'conversations' && migrated) {
          conversationsMigrated = true;
        }
      }

      // Only clear derived summary cache inside THIS profile directory so Antigravity
      // rebuilds its conversation index from the newly linked shared `conversations/`.
      if (conversationsMigrated) {
        for (const cacheFile of DERIVED_SUMMARY_CACHE_FILES) {
          fs.rmSync(path.join(antigravityDataDir, cacheFile), { force: true });
        }
      }
    } else {
      unlinkSharedDirIfSymlink(path.join(geminiConfigDir, 'projects'));
      try {
        const mcpLink = path.join(geminiConfigDir, 'mcp_config.json');
        if (fs.lstatSync(mcpLink).isSymbolicLink()) {
          fs.unlinkSync(mcpLink);
        }
      } catch {
        // ignore
      }
      for (const dirName of ANTIGRAVITY_SHARED_DATA_DIRS) {
        unlinkSharedDirIfSymlink(path.join(antigravityDataDir, dirName));
      }
    }

    // Initialize an isolated macOS login.keychain-db strictly within this profile's HOME + CFFIXED_USER_HOME
    // so `cfprefsd` and the user's real `~/Library/Preferences/com.apple.security.plist` are never touched.
    const kcPath = path.join(profileHome, 'Library', 'Keychains', 'login.keychain-db');
    if (!fs.existsSync(kcPath)) {
      await execFileAsync('/usr/bin/security', ['create-keychain', '-p', '', kcPath], {
        env,
        timeout: 10000,
      });
      await execFileAsync('/usr/bin/security', ['set-keychain-settings', kcPath], {
        env,
        timeout: 10000,
      });
    }

    try {
      await execFileAsync('/usr/bin/security', ['unlock-keychain', '-p', '', kcPath], {
        env,
        timeout: 10000,
      });
    } catch {
      // Already unlocked or empty-passphrase unlock not required
    }

    await execFileAsync('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', kcPath], {
      env,
      timeout: 10000,
    });
    await execFileAsync('/usr/bin/security', ['default-keychain', '-d', 'user', '-s', kcPath], {
      env,
      timeout: 10000,
    });

    options.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'ENV_ISOLATION',
      operation: `prepare isolated env (${account.nickname})`,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      detail: profileHome,
    });

    return built;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'ENV_ISOLATION',
      operation: `prepare isolated env (${account.nickname})`,
      status: 'error',
      durationMs: Date.now() - startedAt,
      detail: msg,
    });
    throw err;
  }
}

function unlinkSymlinksInDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  for (const entry of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, entry);
    try {
      if (fs.lstatSync(full).isSymbolicLink()) {
        fs.unlinkSync(full);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Remove an isolated profile directory when the user deletes an account slot.
 * Unlinks symlinks explicitly first as defense-in-depth and guards strictly
 * against removing `realHome` or anything outside `profilesRootDir`.
 */
export function removeIsolatedProfileDir(
  account: Pick<AccountProfile, 'id' | 'isolationMode'>,
  profilesRootDir: string,
  realHome = os.homedir(),
): void {
  if (account.isolationMode !== 'isolated') return;
  const rootCanonical = canonicalizeDir(profilesRootDir);
  const profileHome = getProfileHomeDir(account, rootCanonical, realHome);
  const relative = path.relative(rootCanonical, profileHome);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to delete path outside profiles root: ${profileHome}`);
  }
  unlinkSymlinksInDir(profileHome);
  unlinkSymlinksInDir(path.join(profileHome, '.gemini', 'config'));
  unlinkSymlinksInDir(path.join(profileHome, '.gemini', 'antigravity'));
  fs.rmSync(profileHome, { recursive: true, force: true });
}
