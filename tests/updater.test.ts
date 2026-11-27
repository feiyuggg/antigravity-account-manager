import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkGitHubLatestRelease,
  compareSemver,
  downloadUrlToFile,
  isAllowedGitHubUrl,
  parseSha256Sums,
  resolveCurrentAppBundlePath,
  selectReleaseAssets,
  verifyFileSha256,
} from '../electron/updater';

describe('GitHub updater helpers and download verification', () => {
  it('compares semver strings accurately across major/minor/patch and prerelease', () => {
    expect(compareSemver('v1.0.2', '1.0.1')).toBeGreaterThan(0);
    expect(compareSemver('1.1.0', '1.0.9')).toBeGreaterThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.0.2', 'v1.0.2')).toBe(0);
    expect(compareSemver('1.0.2', '1.0.2-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.0.1', '1.0.2')).toBeLessThan(0);
  });

  it('selects matching macOS zip asset, verifies SHA-256, and validates URLs', async () => {
    const { zipAsset, sha256Asset } = selectReleaseAssets(
      [
        {
          name: 'Antigravity-Account-Manager-1.0.2-macOS-arm64.dmg',
          browser_download_url: 'https://github.com/feiyuggg/antigravity-account-manager/releases/download/v1.0.2/dmg',
        },
        {
          name: 'Antigravity-Account-Manager-1.0.2-macOS-arm64.zip',
          browser_download_url: 'https://github.com/feiyuggg/antigravity-account-manager/releases/download/v1.0.2/zip',
        },
        {
          name: 'SHA256SUMS.txt',
          browser_download_url: 'https://github.com/feiyuggg/antigravity-account-manager/releases/download/v1.0.2/SHA256SUMS.txt',
        },
      ],
      'arm64',
    );
    expect(zipAsset?.name).toBe('Antigravity-Account-Manager-1.0.2-macOS-arm64.zip');
    expect(sha256Asset?.name).toBe('SHA256SUMS.txt');

    const parsed = parseSha256Sums(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  Antigravity-Account-Manager-1.0.2-macOS-arm64.dmg\n' +
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  Antigravity-Account-Manager-1.0.2-macOS-arm64.zip\n',
    );
    expect(parsed['Antigravity-Account-Manager-1.0.2-macOS-arm64.zip']).toBe('b'.repeat(64));

    expect(resolveCurrentAppBundlePath('/Applications/Antigravity Account Manager.app/Contents/MacOS/Antigravity Account Manager')).toBe(
      '/Applications/Antigravity Account Manager.app',
    );
    expect(
      resolveCurrentAppBundlePath(
        '/Users/dev/project/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      ),
    ).toBeNull();

    expect(isAllowedGitHubUrl('https://github.com/feiyuggg/antigravity-account-manager')).toBe(true);
    expect(
      isAllowedGitHubUrl('https://objects.githubusercontent.com/github-production-release-asset/123'),
    ).toBe(true);
    expect(isAllowedGitHubUrl('http://github.com/feiyuggg/antigravity-account-manager')).toBe(false);
    expect(isAllowedGitHubUrl('https://evil.example.com/payload.zip')).toBe(false);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-updater-hash-'));
    try {
      const filePath = path.join(tmpDir, 'sample.zip');
      const data = Buffer.from('test-zip-binary-payload');
      fs.writeFileSync(filePath, data);
      const expected = crypto.createHash('sha256').update(data).digest('hex');
      expect(await verifyFileSha256(filePath, expected)).toBe(true);
      expect(await verifyFileSha256(filePath, '0'.repeat(64))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('checks latest release metadata and downloads redirected files with SHA-256 check', async () => {
    const payload = Buffer.from('synthetic-release-archive-bytes-'.repeat(256));
    const expectedHash = crypto.createHash('sha256').update(payload).digest('hex');

    let serverPort = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/repos/latest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            tag_name: 'v1.0.5',
            html_url: 'https://github.com/feiyuggg/antigravity-account-manager/releases/tag/v1.0.5',
            body: 'Release notes body',
            assets: [
              {
                name: 'Antigravity-Account-Manager-1.0.5-macOS-arm64.zip',
                browser_download_url: `http://127.0.0.1:${serverPort}/download/redirect`,
              },
              {
                name: 'SHA256SUMS.txt',
                browser_download_url: `http://127.0.0.1:${serverPort}/download/sums`,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/download/redirect') {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/download/archive.zip` });
        res.end();
        return;
      }
      if (req.url === '/download/archive.zip') {
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': String(payload.length),
        });
        res.end(payload);
        return;
      }
      if (req.url === '/download/sums') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`${expectedHash}  Antigravity-Account-Manager-1.0.5-macOS-arm64.zip\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    serverPort = typeof address === 'object' && address ? address.port : 0;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-updater-http-'));
    try {
      const checkOutdated = await checkGitHubLatestRelease({
        currentVersion: '1.0.2',
        apiUrl: `http://127.0.0.1:${serverPort}/repos/latest`,
        arch: 'arm64',
        allowLoopbackHttp: true,
      });
      expect(checkOutdated.hasUpdate).toBe(true);
      expect(checkOutdated.latestVersion).toBe('1.0.5');
      expect(checkOutdated.zipAsset?.name).toBe('Antigravity-Account-Manager-1.0.5-macOS-arm64.zip');

      const checkSame = await checkGitHubLatestRelease({
        currentVersion: '1.0.5',
        apiUrl: `http://127.0.0.1:${serverPort}/repos/latest`,
        arch: 'arm64',
        allowLoopbackHttp: true,
      });
      expect(checkSame.hasUpdate).toBe(false);

      const destZip = path.join(tmpDir, 'downloaded.zip');
      const progressEvents: number[] = [];
      await downloadUrlToFile(checkOutdated.zipAsset!.browser_download_url, destZip, {
        allowLoopbackHttp: true,
        onProgress: (pct) => progressEvents.push(pct),
      });

      expect(progressEvents[progressEvents.length - 1]).toBe(100);
      expect(await verifyFileSha256(destZip, expectedHash)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
