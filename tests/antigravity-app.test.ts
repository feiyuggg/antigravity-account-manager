import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../shared/types';
import {
  buildHookShellCommand,
  extractPreservedLaunchArgs,
  extractRemoteDebuggingPort,
  getAntigravityAppStatus,
  hasRemoteDebuggingPortFlag,
  isAntigravityCdpPageTarget,
  launchAppWithEnv,
  mergeLaunchArgs,
  parseLaunchArgs,
  quitAppGracefully,
  runPostRestartCommand,
  runPostRestartCommands,
  syncDevToolsActivePort,
  waitForAntigravityCdpPage,
} from '../electron/antigravityApp';

function createDummyAppBundle(rootDir: string, outFile: string): string {
  const appPath = path.join(rootDir, 'DummyAntigravity.app');
  const macOsDir = path.join(appPath, 'Contents', 'MacOS');
  fs.mkdirSync(macOsDir, { recursive: true });

  fs.writeFileSync(
    path.join(appPath, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>dummy-antigravity</string>
  <key>CFBundleIdentifier</key>
  <string>com.example.dummyantigravity.${Date.now()}</string>
  <key>CFBundleName</key>
  <string>DummyAntigravity</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
</dict>
</plist>
`,
    'utf8',
  );

  const execPath = path.join(macOsDir, 'dummy-antigravity');
  fs.writeFileSync(
    execPath,
    `#!/bin/zsh
printf '{"HOME":"%s","CFFIXED_USER_HOME":"%s","AGY_PROFILE_ID":"%s","AGY_PROFILE_MODE":"%s","ARGS":"%s"}' \\
  "$HOME" "$CFFIXED_USER_HOME" "$AGY_PROFILE_ID" "$AGY_PROFILE_MODE" "$*" > "${outFile}"
trap 'exit 0' TERM INT
sleep 30 &
wait $!
`,
    'utf8',
  );
  fs.chmodSync(execPath, 0o755);
  return appPath;
}

describe('App lifecycle: launch-arg preservation, --env + --args relaunch, and post-restart hook', () => {
  it('parses, extracts, merges, and detects --remote-debugging-port launch args', () => {
    expect(parseLaunchArgs('  --remote-debugging-port=58321   --foo="bar baz" ')).toEqual([
      '--remote-debugging-port=58321',
      '--foo=bar baz',
    ]);

    const preserved = extractPreservedLaunchArgs([
      {
        pid: 100,
        ppid: 1,
        command: '/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=58322',
      },
      {
        pid: 101,
        ppid: 100,
        command: '/Applications/Antigravity.app/Contents/Frameworks/Helper --type=renderer',
      },
    ]);
    expect(preserved).toEqual(['--remote-debugging-port=58322']);
    expect(extractRemoteDebuggingPort(preserved)).toBe(58322);

    // Configured port wins over preserved port
    expect(mergeLaunchArgs(['--remote-debugging-port=58321'], preserved)).toEqual([
      '--remote-debugging-port=58321',
    ]);
    expect(mergeLaunchArgs(['--enable-features=Demo'], preserved)).toEqual([
      '--enable-features=Demo',
      '--remote-debugging-port=58322',
    ]);

    // Also preserves `--remote-debugging-port=0` (used by Obsidian Prism)
    const zeroPort = extractPreservedLaunchArgs([
      {
        pid: 200,
        ppid: 1,
        command: '/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=0',
      },
    ]);
    expect(zeroPort).toEqual(['--remote-debugging-port=0']);
    expect(hasRemoteDebuggingPortFlag(zeroPort)).toBe(true);
    expect(hasRemoteDebuggingPortFlag(['--remote-debugging-port=58321'])).toBe(true);
  });

  it('filters CDP targets and waits until a workbench page appears', async () => {
    expect(
      isAntigravityCdpPageTarget({
        type: 'page',
        url: 'data:text/html,<html>splash</html>',
      }),
    ).toBe(false);
    expect(
      isAntigravityCdpPageTarget({
        type: 'iframe',
        url: 'plugin://swarm--swarm_board-1234/',
      }),
    ).toBe(false);
    expect(
      isAntigravityCdpPageTarget({
        type: 'page',
        url: 'devtools://devtools/bundled/inspector.html',
      }),
    ).toBe(false);
    expect(
      isAntigravityCdpPageTarget({
        type: 'page',
        url: 'https://127.0.0.1:53892/c/test-session?project=demo',
      }),
    ).toBe(true);
    expect(
      isAntigravityCdpPageTarget({
        type: 'page',
        url: 'vscode-file://vscode-app/Applications/Antigravity.app/workbench.html',
      }),
    ).toBe(true);

    let polls = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/json/list') {
        polls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const payload =
          polls < 3
            ? [{ type: 'page', url: 'data:text/html,splash', title: 'splash' }]
            : [
                { type: 'page', url: 'data:text/html,splash', title: 'splash' },
                { type: 'page', url: 'https://127.0.0.1:53892/c/abc', title: 'Antigravity' },
              ];
        res.end(JSON.stringify(payload));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const ready = await waitForAntigravityCdpPage(port, {
        timeoutMs: 3000,
        pollIntervalMs: 50,
        settleDelayMs: 20,
      });
      expect(ready).toBe(true);
      expect(polls).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('builds preferred PATH shell hook command and captures hook output & failures', async () => {
    const wrapped = buildHookShellCommand('node -v', ['/opt/homebrew/opt/node@22/bin']);
    expect(wrapped).toBe('export PATH=\'/opt/homebrew/opt/node@22/bin\':"$PATH"; node -v');

    const audits: AuditEntry[] = [];
    const result = await runPostRestartCommands(
      [
        { name: 'OkHook', command: 'echo "hook_stdout_ok"', enabled: true },
        { name: 'FailHook', command: 'echo "hook_err_detail" >&2; exit 23', enabled: true },
      ],
      {
        waitForPort: null,
        fallbackDelayMs: 20,
        hookObserveWindowMs: 3000,
        onAudit: (entry) => {
          const idx = audits.findIndex((a) => a.id === entry.id);
          if (idx >= 0) audits[idx] = entry;
          else audits.push(entry);
        },
      },
    );

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('FailHook');
    expect(result.failed[0].detail).toContain('exit=23');
    expect(result.failed[0].detail).toContain('hook_err_detail');

    const okAudit = audits.find((a) => a.operation === 'post-restart hook: OkHook');
    expect(okAudit?.status).toBe('ok');
    expect(okAudit?.detail).toContain('hook_stdout_ok');
  });

  it('syncs DevToolsActivePort from isolated profile to realHome and runs multiple hooks', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-devtools-sync-'));
    const profileHome = path.join(tmpDir, 'profile-home');
    const realHome = path.join(tmpDir, 'real-home');
    const srcPortFile = path.join(
      profileHome,
      'Library',
      'Application Support',
      'Antigravity',
      'DevToolsActivePort',
    );
    const dstPortFile = path.join(
      realHome,
      'Library',
      'Application Support',
      'Antigravity',
      'DevToolsActivePort',
    );
    const marker1 = path.join(tmpDir, 'hook1.txt');
    const marker2 = path.join(tmpDir, 'hook2.txt');
    const markerDisabled = path.join(tmpDir, 'hook-disabled.txt');

    try {
      fs.mkdirSync(path.dirname(srcPortFile), { recursive: true });
      fs.writeFileSync(srcPortFile, '58321\n/devtools/browser/test-uuid\n', 'utf8');

      const syncedPort = await syncDevToolsActivePort({
        profileHome,
        realHome,
        timeoutMs: 2000,
      });
      expect(syncedPort).toBe(58321);
      expect(fs.readFileSync(dstPortFile, 'utf8')).toBe('58321\n/devtools/browser/test-uuid\n');

      await runPostRestartCommands(
        [
          { name: 'Plugin A', command: `printf "a" > "${marker1}"`, enabled: true },
          { name: 'Disabled', command: `printf "x" > "${markerDisabled}"`, enabled: false },
          { name: 'Plugin B', command: `printf "b" > "${marker2}"`, enabled: true },
        ],
        {
          waitForPort: null,
          fallbackDelayMs: 50,
        },
      );

      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(marker1) && fs.existsSync(marker2)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(fs.readFileSync(marker1, 'utf8')).toBe('a');
      expect(fs.readFileSync(marker2, 'utf8')).toBe('b');
      expect(fs.existsSync(markerDisabled)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('injects isolated env and launchArgs via open -n -a --env --args and runs postRestartCommand', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-dummy-app-'));
    const outFile = path.join(tmpDir, 'captured-env.json');
    const hookMarkerFile = path.join(tmpDir, 'hook-ran.txt');
    const dummyHome = path.join(tmpDir, 'slot-home-2');
    fs.mkdirSync(dummyHome, { recursive: true });

    const dummyAppPath = createDummyAppBundle(tmpDir, outFile);

    try {
      await launchAppWithEnv(
        dummyAppPath,
        {
          HOME: dummyHome,
          CFFIXED_USER_HOME: dummyHome,
          AGY_PROFILE_ID: 'slot-2',
          AGY_PROFILE_MODE: 'isolated',
        },
        {
          launchArgs: ['--remote-debugging-port=58321', '--test-flag=yes'],
        },
      );

      let captured: Record<string, string> | null = null;
      for (let i = 0; i < 30; i++) {
        if (fs.existsSync(outFile)) {
          try {
            captured = JSON.parse(fs.readFileSync(outFile, 'utf8'));
            break;
          } catch {
            // file may still be flushing
          }
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      expect(captured).not.toBeNull();
      expect(captured?.HOME).toBe(dummyHome);
      expect(captured?.CFFIXED_USER_HOME).toBe(dummyHome);
      expect(captured?.AGY_PROFILE_ID).toBe('slot-2');
      expect(captured?.AGY_PROFILE_MODE).toBe('isolated');
      expect(captured?.ARGS).toContain('--remote-debugging-port=58321');
      expect(captured?.ARGS).toContain('--test-flag=yes');

      const runningStatus = await getAntigravityAppStatus(dummyAppPath);
      expect(runningStatus.exists).toBe(true);
      expect(runningStatus.running).toBe(true);
      expect(runningStatus.pids.length).toBeGreaterThan(0);

      await runPostRestartCommand(`printf "ok:%s" "$HOME" > "${hookMarkerFile}"`, {
        waitForPort: null,
        fallbackDelayMs: 50,
      });

      let hookContent = '';
      for (let i = 0; i < 20; i++) {
        if (fs.existsSync(hookMarkerFile)) {
          hookContent = fs.readFileSync(hookMarkerFile, 'utf8');
          if (hookContent) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(hookContent).toBe(`ok:${os.homedir()}`);

      await quitAppGracefully(dummyAppPath, { timeoutMs: 5000 });

      const afterQuitStatus = await getAntigravityAppStatus(dummyAppPath);
      expect(afterQuitStatus.running).toBe(false);
      expect(afterQuitStatus.pids).toHaveLength(0);
    } finally {
      try {
        await quitAppGracefully(dummyAppPath, { timeoutMs: 2000 });
      } catch {
        // ignore cleanup
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 20000);
});
