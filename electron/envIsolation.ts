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

const GEMINI_CONFIG_ITEMS_TO_SHARE = [
  'skills',
  'plugins',
  'rules',
  'obsidian-prism-sidebar.json',
  'obsidian-prism-wallpaper.json',
];

const ANTIGRAVITY_SHARED_DATA_DIRS = [
  'conversations',
  'conversations_archive',
  'brain',
  'annotations',
  'scratch',
  'knowledge',
  'chapter_titles',
];

function sqlQuoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isSymlinkToTarget(linkPath: string, expectedTarget: string): boolean {
  try {
    const stat = fs.lstatSync(linkPath);
    return stat.isSymbolicLink() && fs.readlinkSync(linkPath) === expectedTarget;
  } catch {
    return false;
  }
}

function unlinkIfSymlink(filePath: string): void {
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore
  }
}

const CONVERSATION_SUMMARY_COLUMNS = [
  'conversation_id',
  'title',
  'preview',
  'step_count',
  'last_modified_time',
  'workspace_uris',
  'status',
  'source',
  'project_id',
  'agent_name',
  'parent_conversation_id',
  'nesting_depth',
  'battle_id',
  'winning_conversation_id',
  'not_fully_idle',
  'killed',
  'last_user_input_time',
  'last_user_input_step_index',
  'app_data_dir',
  'raw_summary',
  'group_id',
];

/**
 * Merge any unshared conversation summary rows from an isolated slot's `conversation_summaries.db`
 * back into `realAntigravityDir`, then symlink `conversation_summaries.db` and `agyhub_summaries_proto.pb`
 * so every account slot immediately sees the complete shared conversation history list.
 */
async function mergeAndLinkConversationSummaries(
  realAntigravityDir: string,
  profileAntigravityDir: string,
  deferIfSlotInUse = false,
): Promise<void> {
  const realDb = path.join(realAntigravityDir, 'conversation_summaries.db');
  const profileDb = path.join(profileAntigravityDir, 'conversation_summaries.db');
  const realProto = path.join(realAntigravityDir, 'agyhub_summaries_proto.pb');
  const profileProto = path.join(profileAntigravityDir, 'agyhub_summaries_proto.pb');

  if (!deferIfSlotInUse) {
    let profileDbStat: fs.Stats | null = null;
    try {
      profileDbStat = fs.lstatSync(profileDb);
    } catch {
      profileDbStat = null;
    }

    if (!fs.existsSync(realDb) && profileDbStat && profileDbStat.isFile()) {
      fs.mkdirSync(realAntigravityDir, { recursive: true });
      fs.copyFileSync(profileDb, realDb);
      for (const sidecar of ['-wal', '-shm']) {
        if (fs.existsSync(`${profileDb}${sidecar}`)) {
          fs.copyFileSync(`${profileDb}${sidecar}`, `${realDb}${sidecar}`);
        }
      }
    }

    if (fs.existsSync(realDb)) {
      let mergedOrReadyToLink = true;

      if (profileDbStat && !profileDbStat.isSymbolicLink() && profileDbStat.isFile()) {
        const colList = CONVERSATION_SUMMARY_COLUMNS.join(', ');
        const sql = [
          'PRAGMA busy_timeout = 3000;',
          `ATTACH DATABASE ${sqlQuoteString(profileDb)} AS slot;`,
          `INSERT INTO main.conversation_summaries (${colList})`,
          `SELECT ${colList} FROM slot.conversation_summaries WHERE 1`,
          'ON CONFLICT(conversation_id) DO UPDATE SET',
          '  title = COALESCE(NULLIF(excluded.title, \'\'), main.conversation_summaries.title),',
          '  preview = COALESCE(NULLIF(excluded.preview, \'\'), main.conversation_summaries.preview),',
          '  step_count = MAX(excluded.step_count, main.conversation_summaries.step_count),',
          '  last_modified_time = excluded.last_modified_time,',
          '  workspace_uris = COALESCE(NULLIF(excluded.workspace_uris, \'\'), main.conversation_summaries.workspace_uris),',
          '  status = excluded.status,',
          '  source = COALESCE(NULLIF(excluded.source, \'\'), main.conversation_summaries.source),',
          '  project_id = COALESCE(NULLIF(excluded.project_id, \'\'), main.conversation_summaries.project_id),',
          '  agent_name = COALESCE(NULLIF(excluded.agent_name, \'\'), main.conversation_summaries.agent_name),',
          '  parent_conversation_id = COALESCE(NULLIF(excluded.parent_conversation_id, \'\'), main.conversation_summaries.parent_conversation_id),',
          '  nesting_depth = excluded.nesting_depth,',
          '  battle_id = COALESCE(NULLIF(excluded.battle_id, \'\'), main.conversation_summaries.battle_id),',
          '  winning_conversation_id = COALESCE(NULLIF(excluded.winning_conversation_id, \'\'), main.conversation_summaries.winning_conversation_id),',
          '  not_fully_idle = excluded.not_fully_idle,',
          '  killed = excluded.killed,',
          '  last_user_input_time = excluded.last_user_input_time,',
          '  last_user_input_step_index = excluded.last_user_input_step_index,',
          '  app_data_dir = COALESCE(NULLIF(excluded.app_data_dir, \'\'), main.conversation_summaries.app_data_dir),',
          '  raw_summary = COALESCE(excluded.raw_summary, main.conversation_summaries.raw_summary),',
          '  group_id = COALESCE(NULLIF(excluded.group_id, \'\'), main.conversation_summaries.group_id)',
          'WHERE excluded.last_modified_time > main.conversation_summaries.last_modified_time;',
          'INSERT OR IGNORE INTO main.conversation_parents (conversation_id, parent_id) SELECT conversation_id, parent_id FROM slot.conversation_parents;',
          'DETACH DATABASE slot;',
          'PRAGMA wal_checkpoint(TRUNCATE);',
        ].join('\n');

        try {
          await execFileAsync('/usr/bin/sqlite3', [realDb, sql], {
            env: buildBaseEnv(),
            timeout: 10000,
          });
        } catch {
          mergedOrReadyToLink = false;
        }
      } else if (profileDbStat && isSymlinkToTarget(profileDb, realDb)) {
        if (fs.existsSync(`${profileDb}-wal`)) {
          try {
            await execFileAsync(
              '/usr/bin/sqlite3',
              [realDb, 'PRAGMA busy_timeout=1500; PRAGMA wal_checkpoint(TRUNCATE);'],
              { env: buildBaseEnv(), timeout: 5000 },
            );
          } catch {
            // ignore busy checkpoint
          }
        }
      }

      if (mergedOrReadyToLink && !isSymlinkToTarget(profileDb, realDb)) {
        for (const f of ['conversation_summaries.db', 'conversation_summaries.db-wal', 'conversation_summaries.db-shm']) {
          fs.rmSync(path.join(profileAntigravityDir, f), { force: true });
        }
        fs.symlinkSync(realDb, profileDb);
      }
    }

    if (fs.existsSync(realProto) && !isSymlinkToTarget(profileProto, realProto)) {
      fs.rmSync(profileProto, { force: true });
      fs.symlinkSync(realProto, profileProto);
    }
  }
}

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
    isProfileInUse?: boolean;
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

      for (const dirName of ANTIGRAVITY_SHARED_DATA_DIRS) {
        linkSharedDirWithMerge(
          path.join(realHome, '.gemini', 'antigravity', dirName),
          path.join(antigravityDataDir, dirName),
        );
      }

      await mergeAndLinkConversationSummaries(
        path.join(realHome, '.gemini', 'antigravity'),
        antigravityDataDir,
        Boolean(options.isProfileInUse),
      );
    } else {
      unlinkSharedDirIfSymlink(path.join(geminiConfigDir, 'projects'));
      unlinkIfSymlink(path.join(geminiConfigDir, 'mcp_config.json'));
      for (const dirName of ANTIGRAVITY_SHARED_DATA_DIRS) {
        unlinkSharedDirIfSymlink(path.join(antigravityDataDir, dirName));
      }
      unlinkIfSymlink(path.join(antigravityDataDir, 'conversation_summaries.db'));
      unlinkIfSymlink(path.join(antigravityDataDir, 'agyhub_summaries_proto.pb'));
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
