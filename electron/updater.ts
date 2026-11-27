import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AuditEntry } from '../shared/types';
import { buildBaseEnv } from './acp/binary';

const execFileAsync = promisify(execFile);

export type AuditSink = (entry: AuditEntry) => void;

export const GITHUB_REPO = 'feiyuggg/antigravity-account-manager';
export const GITHUB_LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;

const ALLOWED_GITHUB_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'codeload.github.com',
]);

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  content_type?: string;
}

export interface GitHubLatestReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface ReleaseCheckResult {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  releaseNotes?: string;
  zipAsset: GitHubReleaseAsset | null;
  sha256Asset: GitHubReleaseAsset | null;
}

export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

function parseSemverParts(raw: string): { core: [number, number, number]; prerelease: string } {
  const cleaned = normalizeVersion(raw);
  const [corePart, ...preParts] = cleaned.split('-');
  const segments = corePart.split('.').map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return {
    core: [segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0],
    prerelease: preParts.join('-'),
  };
}

/**
 * Compare two semver strings. Returns >0 if `a > b`, <0 if `a < b`, 0 if equal.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemverParts(a);
  const pb = parseSemverParts(b);
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) {
      return pa.core[i] - pb.core[i];
    }
  }
  if (!pa.prerelease && pb.prerelease) return 1;
  if (pa.prerelease && !pb.prerelease) return -1;
  if (pa.prerelease === pb.prerelease) return 0;
  return pa.prerelease > pb.prerelease ? 1 : -1;
}

export function selectReleaseAssets(
  assets: GitHubReleaseAsset[],
  arch: string = process.arch,
): { zipAsset: GitHubReleaseAsset | null; sha256Asset: GitHubReleaseAsset | null } {
  const zipAssets = assets.filter((a) => a.name.endsWith('.zip') && a.browser_download_url);
  const archToken = `-macOS-${arch}.zip`;
  const zipAsset =
    zipAssets.find((a) => a.name.includes(archToken)) ??
    zipAssets.find((a) => /-macOS-[^/]+\.zip$/i.test(a.name)) ??
    zipAssets[0] ??
    null;

  const sha256Asset =
    assets.find((a) => a.name === 'SHA256SUMS.txt' && Boolean(a.browser_download_url)) ?? null;

  return { zipAsset, sha256Asset };
}

export function parseSha256Sums(content: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!match) continue;
    const hash = match[1].toLowerCase();
    const filename = path.basename(match[2].trim());
    if (filename) {
      map[filename] = hash;
    }
  }
  return map;
}

export async function verifyFileSha256(filePath: string, expectedHash: string): Promise<boolean> {
  const expected = expectedHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  const actual = await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
  return actual === expected;
}

/**
 * Resolve the outer `.app` bundle path when running inside a packaged build;
 * returns null during local `electron .` development to protect `node_modules/electron`.
 */
export function resolveCurrentAppBundlePath(execPath: string = process.execPath): string | null {
  const normalized = path.resolve(execPath);
  const match = normalized.match(/^(.*\.app)\/Contents\/MacOS\/[^/]+$/);
  if (!match) {
    return null;
  }
  const bundlePath = match[1];
  if (path.basename(bundlePath) === 'Electron.app') {
    return null;
  }
  return bundlePath;
}

export function isAllowedGitHubUrl(rawUrl: string, allowLoopbackHttp = false): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (allowLoopbackHttp && parsed.protocol === 'http:') {
    return (
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '::1' ||
      parsed.hostname === '[::1]'
    );
  }

  if (parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  return ALLOWED_GITHUB_HOSTS.has(host) || host.endsWith('.githubusercontent.com');
}

function requestWithRedirects(
  rawUrl: string,
  options: {
    headers?: Record<string, string>;
    allowLoopbackHttp?: boolean;
    maxRedirects?: number;
    timeoutMs?: number;
  },
  redirectsLeft = options.maxRedirects ?? 5,
): Promise<{ response: http.IncomingMessage; finalUrl: string }> {
  return new Promise((resolve, reject) => {
    if (!isAllowedGitHubUrl(rawUrl, options.allowLoopbackHttp)) {
      reject(new Error(`不允许从非 GitHub 官方来源下载: ${rawUrl}`));
      return;
    }

    const parsed = new URL(rawUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      parsed,
      {
        headers: {
          'User-Agent': 'antigravity-account-manager-updater',
          ...options.headers,
        },
        timeout: options.timeoutMs ?? 15000,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error('下载重定向次数过多'));
            return;
          }
          const nextUrl = new URL(location, parsed).toString();
          requestWithRedirects(nextUrl, options, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (errBody.length < 400) errBody += chunk;
          });
          res.on('end', () => {
            reject(new Error(`GitHub 请求失败 (HTTP ${status}): ${errBody.trim() || '未知错误'}`));
          });
          return;
        }

        resolve({ response: res, finalUrl: rawUrl });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error('请求 GitHub 超时'));
    });
    req.on('error', reject);
  });
}

async function fetchText(
  url: string,
  options?: { headers?: Record<string, string>; allowLoopbackHttp?: boolean; timeoutMs?: number },
): Promise<string> {
  const { response } = await requestWithRedirects(url, options ?? {});
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    response.on('error', reject);
  });
}

export async function downloadUrlToFile(
  url: string,
  destPath: string,
  options?: {
    onProgress?: (percent: number) => void;
    allowLoopbackHttp?: boolean;
    maxRedirects?: number;
    timeoutMs?: number;
  },
): Promise<void> {
  const { response } = await requestWithRedirects(url, {
    allowLoopbackHttp: options?.allowLoopbackHttp,
    maxRedirects: options?.maxRedirects,
    timeoutMs: options?.timeoutMs ?? 60000,
  });

  const totalBytes = Number(response.headers['content-length'] ?? 0);
  let downloadedBytes = 0;
  let lastPercent = -1;

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;

  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(tmpPath);
    const cleanup = (err: Error) => {
      out.destroy();
      fs.rmSync(tmpPath, { force: true });
      reject(err);
    };

    response.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0 && options?.onProgress) {
        const pct = Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100));
        if (pct !== lastPercent) {
          lastPercent = pct;
          options.onProgress(pct);
        }
      }
    });
    response.on('error', cleanup);
    out.on('error', cleanup);
    out.on('finish', () => {
      fs.renameSync(tmpPath, destPath);
      options?.onProgress?.(100);
      resolve();
    });

    response.pipe(out);
  });
}

export async function checkGitHubLatestRelease(options: {
  currentVersion: string;
  apiUrl?: string;
  arch?: string;
  allowLoopbackHttp?: boolean;
  timeoutMs?: number;
}): Promise<ReleaseCheckResult> {
  const apiUrl = options.apiUrl ?? GITHUB_LATEST_RELEASE_API;
  const rawJson = await fetchText(apiUrl, {
    headers: { Accept: 'application/vnd.github+json' },
    allowLoopbackHttp: options.allowLoopbackHttp,
    timeoutMs: options.timeoutMs ?? 15000,
  });

  const payload = JSON.parse(rawJson) as GitHubLatestReleaseResponse;
  const tag = payload.tag_name ?? payload.name ?? '';
  if (!tag) {
    throw new Error('GitHub Release 响应缺少版本号 tag_name');
  }

  const currentVersion = normalizeVersion(options.currentVersion);
  const latestVersion = normalizeVersion(tag);
  const assets = Array.isArray(payload.assets) ? payload.assets : [];
  const { zipAsset, sha256Asset } = selectReleaseAssets(assets, options.arch);

  return {
    hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
    currentVersion,
    latestVersion,
    releaseUrl: payload.html_url ?? RELEASES_PAGE_URL,
    releaseNotes: payload.body,
    zipAsset,
    sha256Asset,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findExtractedAppBundle(extractDir: string): string | null {
  for (const entry of fs.readdirSync(extractDir)) {
    if (entry.endsWith('.app')) {
      return path.join(extractDir, entry);
    }
  }
  return null;
}

export async function prepareAndStageMacUpdate(options: {
  zipUrl: string;
  assetName: string;
  sha256Url?: string;
  targetAppPath: string;
  pidToWait?: number;
  allowLoopbackHttp?: boolean;
  onStage?: (phase: 'downloading' | 'verifying' | 'installing', message: string, progressPercent?: number) => void;
  onAudit?: AuditSink;
}): Promise<{ applyScriptPath: string; tempDir: string; extractedApp: string }> {
  const targetParent = path.dirname(options.targetAppPath);
  try {
    fs.accessSync(targetParent, fs.constants.W_OK);
  } catch {
    throw new Error(`无权写入目录 ${targetParent}，请先将应用移至可写目录或手动下载覆盖安装`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-mgr-update-'));
  const zipPath = path.join(tempDir, options.assetName);
  const extractDir = path.join(tempDir, 'extracted');
  const auditId = crypto.randomUUID();
  const startedAt = Date.now();

  options.onAudit?.({
    id: auditId,
    timestamp: new Date().toISOString(),
    source: 'APP_LIFECYCLE',
    operation: `stage update (${options.assetName})`,
    status: 'running',
    detail: options.zipUrl,
  });

  try {
    let lastBroadcastPct = -5;
    options.onStage?.('downloading', `正在下载新版本安装包 ${options.assetName}...`, 0);
    await downloadUrlToFile(options.zipUrl, zipPath, {
      allowLoopbackHttp: options.allowLoopbackHttp,
      onProgress: (pct) => {
        if (pct === 100 || pct - lastBroadcastPct >= 2) {
          lastBroadcastPct = pct;
          options.onStage?.('downloading', `正在下载更新包... ${pct}%`, pct);
        }
      },
    });

    if (options.sha256Url) {
      options.onStage?.('verifying', '正在校验 SHA-256 与代码签名...');
      const sumsText = await fetchText(options.sha256Url, {
        allowLoopbackHttp: options.allowLoopbackHttp,
      });
      const sums = parseSha256Sums(sumsText);
      const expected = sums[path.basename(options.assetName)];
      if (!expected) {
        throw new Error(`SHA256SUMS.txt 中未找到 ${options.assetName} 的校验记录`);
      }
      const matched = await verifyFileSha256(zipPath, expected);
      if (!matched) {
        throw new Error(`更新包 ${options.assetName} SHA-256 校验失败，已终止安装`);
      }
    } else {
      options.onStage?.('verifying', '正在解压并校验应用签名...');
    }

    fs.mkdirSync(extractDir, { recursive: true });
    await execFileAsync('/usr/bin/ditto', ['-x', '-k', zipPath, extractDir], {
      env: buildBaseEnv(),
      timeout: 60000,
    });

    const extractedApp = findExtractedAppBundle(extractDir);
    if (!extractedApp) {
      throw new Error('更新压缩包内未找到 .app 应用包');
    }

    await execFileAsync('/usr/bin/xattr', ['-cr', extractedApp], {
      env: buildBaseEnv(),
      timeout: 15000,
    });
    await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp], {
      env: buildBaseEnv(),
      timeout: 30000,
    });

    options.onStage?.('installing', '校验通过，正在准备替换并重启应用...');

    const pid = options.pidToWait ?? process.pid;
    const backupApp = `${options.targetAppPath}.old-backup`;
    const scriptContent = `#!/bin/sh
set -u
PID=${pid}
NEW_APP=${shellQuote(extractedApp)}
TARGET_APP=${shellQuote(options.targetAppPath)}
BACKUP_APP=${shellQuote(backupApp)}
TMP_DIR=${shellQuote(tempDir)}

i=0
while [ $i -lt 60 ]; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done

rm -rf "$BACKUP_APP"
if [ -d "$TARGET_APP" ]; then
  if ! mv "$TARGET_APP" "$BACKUP_APP"; then
    exit 1
  fi
fi

if /usr/bin/ditto "$NEW_APP" "$TARGET_APP"; then
  /usr/bin/xattr -cr "$TARGET_APP" 2>/dev/null || true
  rm -rf "$BACKUP_APP"
  rm -rf "$TMP_DIR"
  /usr/bin/open -n "$TARGET_APP"
  exit 0
else
  rm -rf "$TARGET_APP"
  if [ -d "$BACKUP_APP" ]; then
    mv "$BACKUP_APP" "$TARGET_APP" || true
  fi
  /usr/bin/open -n "$TARGET_APP" 2>/dev/null || true
  exit 1
fi
`;
    const applyScriptPath = path.join(tempDir, 'apply-update.sh');
    fs.writeFileSync(applyScriptPath, scriptContent, { mode: 0o700 });

    options.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `stage update (${options.assetName})`,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      detail: `target=${options.targetAppPath}`,
    });

    return { applyScriptPath, tempDir, extractedApp };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fs.rmSync(tempDir, { recursive: true, force: true });
    options.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `stage update (${options.assetName})`,
      status: 'error',
      durationMs: Date.now() - startedAt,
      detail: msg,
    });
    throw err;
  }
}

export function launchDetachedApplyScript(applyScriptPath: string): void {
  const child = spawn('/bin/sh', [applyScriptPath], {
    detached: true,
    stdio: 'ignore',
    env: buildBaseEnv(),
  });
  child.unref();
}
