import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcpClient,
  TerminalLoginSession,
  extractAuthUrl,
  extractAuthenticatedEmailFromLog,
} from '../electron/acp/client';

const MOCK_SERVER = path.resolve(__dirname, 'mock-acp-server.mjs');

describe('AcpClient & TerminalLoginSession with isolated env propagation', () => {
  it('propagates isolated env and performs initialize, probeAuthStatus, logout, and authenticate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-client-'));
    const envRecordFile = path.join(tmpDir, 'env.json');
    const probeCwd = path.join(tmpDir, 'cwd');
    const audits: string[] = [];

    const client = new AcpClient({
      agyPath: process.execPath,
      args: [MOCK_SERVER],
      env: {
        ...process.env,
        HOME: path.join(tmpDir, 'slot-home'),
        CFFIXED_USER_HOME: path.join(tmpDir, 'slot-home'),
        AGY_PROFILE_ID: 'slot-1',
        AGY_PROFILE_MODE: 'isolated',
        MOCK_ENV_RECORD_FILE: envRecordFile,
      },
      onAudit: (e) => audits.push(`${e.operation}:${e.status}`),
    });

    try {
      const init = await client.initialize();
      expect(init.agentInfo?.name).toBe('Mock Antigravity ACP Server');

      const recorded = JSON.parse(fs.readFileSync(envRecordFile, 'utf8'));
      expect(recorded.HOME).toBe(path.join(tmpDir, 'slot-home'));
      expect(recorded.CFFIXED_USER_HOME).toBe(path.join(tmpDir, 'slot-home'));
      expect(recorded.AGY_PROFILE_ID).toBe('slot-1');

      const probe1 = await client.probeAuthStatus(probeCwd);
      expect(probe1.authenticated).toBe(true);
      expect(probe1.email).toBe('mock.user@gmail.com');

      await client.logout();
      const probe2 = await client.probeAuthStatus(probeCwd);
      expect(probe2.authenticated).toBe(false);

      await client.authenticate('oauth-business');
      const probe3 = await client.probeAuthStatus(probeCwd);
      expect(probe3.authenticated).toBe(true);

      expect(audits).toContain('initialize:ok');
      expect(audits).toContain('session/new:ok');
      expect(audits).toContain('session/close:ok');
      expect(audits).toContain('logout:ok');
      expect(audits).toContain('authenticate:ok');
    } finally {
      await client.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to auth/logout when logout returns -32601', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-fb-'));
    const client = new AcpClient({
      agyPath: process.execPath,
      args: [MOCK_SERVER],
      env: { ...process.env, MOCK_AUTH_LOGOUT_FALLBACK: '1' },
    });

    try {
      await client.initialize();
      await client.logout();
      const probe = await client.probeAuthStatus(tmpDir);
      expect(probe.authenticated).toBe(false);
    } finally {
      await client.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles agy acp --login URL extraction and code submission', async () => {
    const session = new TerminalLoginSession({
      agyPath: process.execPath,
      args: [MOCK_SERVER, '--login'],
    });

    let capturedUrl: string | undefined;
    let submitted = false;

    await session.start({
      onOutput: (_out, detectedUrl) => {
        if (detectedUrl) {
          capturedUrl = detectedUrl;
          if (!submitted) {
            submitted = true;
            session.submitCode('valid-code-123');
          }
        }
      },
    });

    expect(capturedUrl).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=mock-client&scope=openid',
    );
  });

  it('strips ANSI codes when extracting OAuth URLs', () => {
    const raw =
      '\u001b[36mOpen:\u001b[0m https://accounts.google.com/o/oauth2/auth?foo=bar\n';
    expect(extractAuthUrl(raw)).toBe('https://accounts.google.com/o/oauth2/auth?foo=bar');
  });

  it('captures fallback auth URL emitted on stderr during oauth-personal authenticate', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-url-'));
    const capturedUrls: string[] = [];
    const client = new AcpClient({
      agyPath: process.execPath,
      args: [MOCK_SERVER],
      env: { ...process.env, MOCK_AUTHENTICATED: '0' },
      onAuthUrl: (url) => capturedUrls.push(url),
    });

    try {
      await client.initialize();
      const before = await client.probeAuthStatus(tmpDir);
      expect(before.authenticated).toBe(false);

      await client.authenticate('oauth-personal');
      expect(capturedUrls).toContain(
        'https://accounts.google.com/o/oauth2/auth?client_id=mock-browser-client',
      );

      const after = await client.probeAuthStatus(tmpDir);
      expect(after.authenticated).toBe(true);
      expect(after.email).toBe('mock.user@gmail.com');
    } finally {
      await client.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('extracts authenticated email from both ACP log formats', () => {
    const sample = [
      'I1127 10:58:33.697519 26 server_oauth.go:221] applyAuthResult: email=first@example.com, authMethod=consumer',
      'I1127 10:58:33.697559 26 server_oauth.go:226] OAuth: authenticated successfully as second.user@gmail.com',
    ].join('\n');
    expect(extractAuthenticatedEmailFromLog(sample)).toBe('second.user@gmail.com');
    expect(
      extractAuthenticatedEmailFromLog(
        'I1127 10:58:33.697519 26 server_oauth.go:221] applyAuthResult: email=only@corp.dev, authMethod=enterprise',
      ),
    ).toBe('only@corp.dev');
  });
});
