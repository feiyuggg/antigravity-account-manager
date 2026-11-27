import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgyBinary } from '../electron/acp/binary';
import { AcpClient } from '../electron/acp/client';
import {
  buildProfileEnv,
  ensureIsolatedProfileReady,
  removeIsolatedProfileDir,
} from '../electron/envIsolation';

describe('Environment isolation & keychain separation', () => {
  it('isolates HOME, CFFIXED_USER_HOME, and Keychain while sharing conversations & projects safely', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-env-iso-'));
    const fakeRealHome = path.join(tmpRoot, 'real-home');
    const profilesRoot = path.join(tmpRoot, 'profiles');
    const probeCwd = path.join(tmpRoot, 'probe-cwd');

    fs.mkdirSync(path.join(fakeRealHome, '.gemini', 'config', 'skills'), { recursive: true });
    fs.mkdirSync(path.join(fakeRealHome, '.gemini', 'config', 'projects'), { recursive: true });
    fs.mkdirSync(path.join(fakeRealHome, '.gemini', 'antigravity', 'conversations'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(fakeRealHome, '.zshrc'), '# mock zshrc\n', 'utf8');
    fs.writeFileSync(
      path.join(fakeRealHome, '.gemini', 'config', 'skills', 'demo.txt'),
      'shared-skill',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeRealHome, '.gemini', 'config', 'projects', 'proj-a.json'),
      '{"name":"proj-a"}',
      'utf8',
    );
    fs.writeFileSync(
      path.join(fakeRealHome, '.gemini', 'antigravity', 'conversations', 'real-only.db'),
      'real-convo',
      'utf8',
    );
    fs.mkdirSync(probeCwd, { recursive: true });

    const hostKeychainsBefore = execFileSync('/usr/bin/security', ['list-keychains'], {
      encoding: 'utf8',
    });

    try {
      const account = {
        id: 'slot-alpha',
        nickname: 'Alpha 槽位',
        isolationMode: 'isolated' as const,
      };

      // Simulate an real conversation_summaries.db in fakeRealHome AND a stale unshared one in slot-alpha
      const realAntigravityDir = path.join(fakeRealHome, '.gemini', 'antigravity');
      const realDbPath = path.join(realAntigravityDir, 'conversation_summaries.db');
      const preSlotAntigravityDir = path.join(profilesRoot, 'slot-alpha', '.gemini', 'antigravity');
      const slotDbPath = path.join(preSlotAntigravityDir, 'conversation_summaries.db');
      fs.mkdirSync(path.join(preSlotAntigravityDir, 'conversations'), { recursive: true });
      fs.writeFileSync(
        path.join(preSlotAntigravityDir, 'conversations', 'slot-only.db'),
        'slot-convo',
        'utf8',
      );
      fs.writeFileSync(path.join(realAntigravityDir, 'agyhub_summaries_proto.pb'), 'proto-v1', 'utf8');

      const schemaSql = `
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT "",
          preview TEXT NOT NULL DEFAULT "",
          step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT "",
          source TEXT NOT NULL DEFAULT "",
          project_id TEXT NOT NULL DEFAULT "",
          agent_name TEXT NOT NULL DEFAULT "",
          parent_conversation_id TEXT NOT NULL DEFAULT "",
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          battle_id TEXT NOT NULL DEFAULT "",
          winning_conversation_id TEXT NOT NULL DEFAULT "",
          not_fully_idle NUMERIC NOT NULL DEFAULT false,
          killed NUMERIC NOT NULL DEFAULT false,
          last_user_input_time DATETIME NOT NULL,
          last_user_input_step_index INTEGER NOT NULL DEFAULT -1,
          app_data_dir TEXT NOT NULL DEFAULT "",
          raw_summary BLOB,
          group_id TEXT NOT NULL DEFAULT ""
        );
        CREATE TABLE conversation_parents (
          conversation_id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL
        ) WITHOUT ROWID;
      `;
      execFileSync('/usr/bin/sqlite3', [
        realDbPath,
        `${schemaSql}
        INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, last_user_input_time, app_data_dir)
        VALUES ('c1', 'Old Title', 2, '2026-11-26T10:00:00Z', '[]', '2026-11-26T10:00:00Z', 'antigravity'),
               ('c2', 'Real Only', 4, '2026-11-26T11:00:00Z', '[]', '2026-11-26T11:00:00Z', 'antigravity');`,
      ]);
      execFileSync('/usr/bin/sqlite3', [
        slotDbPath,
        `${schemaSql}
        INSERT INTO conversation_summaries (conversation_id, title, step_count, last_modified_time, workspace_uris, last_user_input_time, app_data_dir)
        VALUES ('c1', 'Newer Slot Title', 8, '2026-11-27T12:00:00Z', '[]', '2026-11-27T12:00:00Z', 'antigravity'),
               ('c3', 'Slot Only', 3, '2026-11-27T13:00:00Z', '[]', '2026-11-27T13:00:00Z', 'antigravity');`,
      ]);

      const built = await ensureIsolatedProfileReady(account, {
        profilesRootDir: profilesRoot,
        realHome: fakeRealHome,
        shareConversationsAndProjects: true,
        shareGlobalCustomizations: true,
        symlinkShellConfig: true,
      });

      expect(built.env.HOME).toBe(built.profileHome);
      expect(built.env.CFFIXED_USER_HOME).toBe(built.profileHome);
      expect(built.env.AGY_PROFILE_ID).toBe('slot-alpha');
      expect(built.env.AGY_PROFILE_MODE).toBe('isolated');

      // .zshrc, skills, projects, conversations, brain, annotations are symlinked,
      // while .gemini, .gemini/antigravity, and Library remain real directories
      expect(fs.lstatSync(path.join(built.profileHome, '.zshrc')).isSymbolicLink()).toBe(true);
      expect(fs.lstatSync(path.join(built.profileHome, '.gemini')).isSymbolicLink()).toBe(false);
      expect(
        fs.lstatSync(path.join(built.profileHome, '.gemini', 'antigravity')).isSymbolicLink(),
      ).toBe(false);
      expect(fs.lstatSync(path.join(built.profileHome, 'Library')).isSymbolicLink()).toBe(false);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'config', 'skills'))
          .isSymbolicLink(),
      ).toBe(true);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'config', 'projects'))
          .isSymbolicLink(),
      ).toBe(true);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'antigravity', 'conversations'))
          .isSymbolicLink(),
      ).toBe(true);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'antigravity', 'brain'))
          .isSymbolicLink(),
      ).toBe(true);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'antigravity', 'annotations'))
          .isSymbolicLink(),
      ).toBe(true);

      // Both real-only.db and migrated slot-only.db exist in fakeRealHome,
      // and conversation_summaries.db + agyhub_summaries_proto.pb are merged and symlinked
      const realConvosDir = path.join(fakeRealHome, '.gemini', 'antigravity', 'conversations');
      expect(fs.existsSync(path.join(realConvosDir, 'real-only.db'))).toBe(true);
      expect(fs.existsSync(path.join(realConvosDir, 'slot-only.db'))).toBe(true);
      const slotDbLink = path.join(
        built.profileHome,
        '.gemini',
        'antigravity',
        'conversation_summaries.db',
      );
      expect(fs.lstatSync(slotDbLink).isSymbolicLink()).toBe(true);
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'antigravity', 'agyhub_summaries_proto.pb'))
          .isSymbolicLink(),
      ).toBe(true);

      const mergedRows = execFileSync(
        '/usr/bin/sqlite3',
        [realDbPath, 'SELECT conversation_id, title FROM conversation_summaries ORDER BY conversation_id;'],
        { encoding: 'utf8' },
      );
      expect(mergedRows.trim().split(/\r?\n/)).toEqual([
        'c1|Newer Slot Title',
        'c2|Real Only',
        'c3|Slot Only',
      ]);

      // A brand-new second slot immediately inherits all merged conversations via symlink
      const betaBuilt = await ensureIsolatedProfileReady(
        { id: 'slot-beta', nickname: 'Beta 槽位', isolationMode: 'isolated' },
        {
          profilesRootDir: profilesRoot,
          realHome: fakeRealHome,
          shareConversationsAndProjects: true,
          shareGlobalCustomizations: true,
          symlinkShellConfig: true,
        },
      );
      const betaDbLink = path.join(
        betaBuilt.profileHome,
        '.gemini',
        'antigravity',
        'conversation_summaries.db',
      );
      expect(fs.lstatSync(betaDbLink).isSymbolicLink()).toBe(true);
      const betaRows = execFileSync(
        '/usr/bin/sqlite3',
        [betaDbLink, 'SELECT count(*) FROM conversation_summaries;'],
        { encoding: 'utf8' },
      ).trim();
      expect(betaRows).toBe('3');

      // Toggling shareConversationsAndProjects to false unlinks cleanly without harming fakeRealHome
      await ensureIsolatedProfileReady(account, {
        profilesRootDir: profilesRoot,
        realHome: fakeRealHome,
        shareConversationsAndProjects: false,
        shareGlobalCustomizations: true,
        symlinkShellConfig: true,
      });
      expect(
        fs
          .lstatSync(path.join(built.profileHome, '.gemini', 'antigravity', 'conversations'))
          .isSymbolicLink(),
      ).toBe(false);
      expect(fs.existsSync(path.join(realConvosDir, 'real-only.db'))).toBe(true);
      expect(fs.existsSync(path.join(realConvosDir, 'slot-only.db'))).toBe(true);

      // Re-enable sharing before testing keychain + deletion safety
      await ensureIsolatedProfileReady(account, {
        profilesRootDir: profilesRoot,
        realHome: fakeRealHome,
        shareConversationsAndProjects: true,
        shareGlobalCustomizations: true,
        symlinkShellConfig: true,
      });

      const kcPath = path.join(built.profileHome, 'Library', 'Keychains', 'login.keychain-db');
      expect(fs.existsSync(kcPath)).toBe(true);

      const isolatedKeychains = execFileSync('/usr/bin/security', ['list-keychains'], {
        env: built.env,
        encoding: 'utf8',
      });
      expect(isolatedKeychains).toContain(kcPath);

      const hostKeychainsAfter = execFileSync('/usr/bin/security', ['list-keychains'], {
        encoding: 'utf8',
      });
      expect(hostKeychainsAfter).toBe(hostKeychainsBefore);

      // Verify real `agy acp` sees an unauthenticated fresh isolated profile (read-only probe)
      const agyPath = resolveAgyBinary();
      if (agyPath) {
        const client = new AcpClient({ agyPath, env: built.env });
        try {
          const init = await client.initialize();
          expect(init.authMethods?.some((m) => m.id === 'terminal-login')).toBe(true);
          const probe = await client.probeAuthStatus(probeCwd);
          expect(probe.authenticated).toBe(false);
        } finally {
          await client.close();
        }
      }

      // Verify clean removal of isolated directory leaves shared fakeRealHome data completely intact
      removeIsolatedProfileDir(account, profilesRoot, fakeRealHome);
      expect(fs.existsSync(built.profileHome)).toBe(false);
      expect(fs.existsSync(path.join(realConvosDir, 'real-only.db'))).toBe(true);
      expect(fs.existsSync(path.join(realConvosDir, 'slot-only.db'))).toBe(true);
      expect(
        fs.existsSync(path.join(fakeRealHome, '.gemini', 'config', 'projects', 'proj-a.json')),
      ).toBe(true);

      // Verify system mode returns realHome untouched
      const sysBuilt = buildProfileEnv(
        { id: 'sys-slot', isolationMode: 'system' },
        { profilesRootDir: profilesRoot, realHome: fakeRealHome },
      );
      expect(sysBuilt.profileHome).toBe(fs.realpathSync(fakeRealHome));
      expect(sysBuilt.env.AGY_PROFILE_MODE).toBe('system');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 20000);
});
