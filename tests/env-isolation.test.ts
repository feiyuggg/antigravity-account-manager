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

      // Simulate an older isolated slot that already has its own conversation & stale cache
      const preSlotAntigravityDir = path.join(profilesRoot, 'slot-alpha', '.gemini', 'antigravity');
      fs.mkdirSync(path.join(preSlotAntigravityDir, 'conversations'), { recursive: true });
      fs.writeFileSync(
        path.join(preSlotAntigravityDir, 'conversations', 'slot-only.db'),
        'slot-convo',
        'utf8',
      );
      fs.writeFileSync(
        path.join(preSlotAntigravityDir, 'conversation_summaries.db'),
        'stale-cache',
        'utf8',
      );

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

      // Both real-only.db and migrated slot-only.db exist in fakeRealHome, and stale profile cache was cleared
      const realConvosDir = path.join(fakeRealHome, '.gemini', 'antigravity', 'conversations');
      expect(fs.existsSync(path.join(realConvosDir, 'real-only.db'))).toBe(true);
      expect(fs.existsSync(path.join(realConvosDir, 'slot-only.db'))).toBe(true);
      expect(
        fs.existsSync(
          path.join(built.profileHome, '.gemini', 'antigravity', 'conversation_summaries.db'),
        ),
      ).toBe(false);

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
