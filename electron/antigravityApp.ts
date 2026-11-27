import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  AntigravityAppStatus,
  AuditEntry,
  PostRestartHooksResult,
} from '../shared/types';
import { buildBaseEnv, getPreferredRuntimeBinDirs } from './acp/binary';

const execFileAsync = promisify(execFile);

export type AuditSink = (entry: AuditEntry) => void;

export const DEFAULT_ANTIGRAVITY_APP_PATH = '/Applications/Antigravity.app';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAppMacOsDirPrefix(appPath: string): string {
  let resolved = appPath;
  try {
    resolved = fs.realpathSync(appPath);
  } catch {
    // keep raw path if not yet resolved
  }
  return path.join(resolved, 'Contents', 'MacOS') + path.sep;
}

/**
 * Find all PIDs whose executable path resides inside `<appPath>/Contents/MacOS/`.
 * Uses `ps -ax -o pid=,ppid=,command=` directly without shelling out.
 */
export async function findAppProcessPids(
  appPath: string,
): Promise<Array<{ pid: number; ppid: number; command: string }>> {
  const macOsPrefix = getAppMacOsDirPrefix(appPath);
  const rawPrefix = path.join(appPath, 'Contents', 'MacOS') + path.sep;

  const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,ppid=,command='], {
    env: buildBaseEnv(),
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });

  const matches: Array<{ pid: number; ppid: number; command: string }> = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (pid === process.pid) continue;
    if (command.includes(macOsPrefix) || command.includes(rawPrefix)) {
      matches.push({ pid, ppid, command });
    }
  }
  return matches;
}

export async function getAntigravityAppStatus(appPath: string): Promise<AntigravityAppStatus> {
  const exists = fs.existsSync(appPath);
  let pids: number[] = [];
  if (exists) {
    try {
      const procs = await findAppProcessPids(appPath);
      pids = procs.map((p) => p.pid);
    } catch {
      pids = [];
    }
  }
  return {
    appPath,
    exists,
    running: pids.length > 0,
    pids,
    checkedAt: new Date().toISOString(),
  };
}

function getMainBundleProcessPids(
  procs: Array<{ pid: number; ppid: number; command: string }>,
): number[] {
  const pidSet = new Set(procs.map((p) => p.pid));
  const roots = procs.filter((p) => !pidSet.has(p.ppid)).map((p) => p.pid);
  return roots.length > 0 ? roots : procs.map((p) => p.pid);
}

/**
 * Parse a shell-like argument string into individual tokens (supports single & double quotes).
 */
export function parseLaunchArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Extract `--remote-debugging-port=<port>` from currently running Antigravity processes
 * so CDP-based plugins survive account switches automatically.
 */
export function extractPreservedLaunchArgs(
  procs: Array<{ pid: number; ppid: number; command: string }>,
): string[] {
  const rootPids = new Set(getMainBundleProcessPids(procs));
  const ordered = [
    ...procs.filter((p) => rootPids.has(p.pid)),
    ...procs.filter((p) => !rootPids.has(p.pid)),
  ];

  for (const proc of ordered) {
    const match = proc.command.match(/--remote-debugging-port(?:=|\s+)(\d+)/);
    if (match) {
      const port = Number(match[1]);
      if (Number.isInteger(port) && port >= 0 && port <= 65535) {
        return [`--remote-debugging-port=${port}`];
      }
    }
  }
  return [];
}

/**
 * Merge user-configured launch args with preserved runtime args.
 * User-configured `--remote-debugging-port` takes priority over preserved flags.
 */
export function mergeLaunchArgs(configuredArgs: string[], preservedArgs: string[]): string[] {
  const result = [...configuredArgs];
  const hasConfiguredPort = hasRemoteDebuggingPortFlag(configuredArgs);

  for (const arg of preservedArgs) {
    if (arg.startsWith('--remote-debugging-port') && hasConfiguredPort) {
      continue;
    }
    if (!result.includes(arg)) {
      result.push(arg);
    }
  }
  return result;
}

export function extractRemoteDebuggingPort(launchArgs: string[]): number | null {
  for (let i = 0; i < launchArgs.length; i++) {
    const arg = launchArgs[i];
    const eqMatch = arg.match(/^--remote-debugging-port=(\d+)$/);
    if (eqMatch) {
      const port = Number(eqMatch[1]);
      return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
    }
    if (arg === '--remote-debugging-port' && i + 1 < launchArgs.length) {
      const port = Number(launchArgs[i + 1]);
      return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
    }
  }
  return null;
}

export function hasRemoteDebuggingPortFlag(launchArgs: string[]): boolean {
  return extractRemoteDebuggingPort(launchArgs) !== null;
}

export async function waitForLoopbackPort(port: number, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 400);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

/**
 * Gracefully quit the target `.app` bundle and wait until every process inside
 * `<appPath>/Contents/MacOS/` has completely exited so single-instance lock is freed.
 */
export async function quitAppGracefully(
  appPath: string,
  options?: { timeoutMs?: number; onAudit?: AuditSink },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 8000;
  const auditId = crypto.randomUUID();
  const startedAt = Date.now();

  options?.onAudit?.({
    id: auditId,
    timestamp: new Date().toISOString(),
    source: 'APP_LIFECYCLE',
    operation: `quit ${path.basename(appPath)}`,
    status: 'running',
    detail: appPath,
  });

  try {
    let procs = await findAppProcessPids(appPath);
    if (procs.length === 0) {
      options?.onAudit?.({
        id: auditId,
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: `quit ${path.basename(appPath)}`,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        detail: 'App was not running',
      });
      return;
    }

    // Attempt gentle Cocoa quit via AppleScript first for standard GUI apps, then SIGTERM root PIDs.
    try {
      await execFileAsync(
        '/usr/bin/osascript',
        ['-e', `tell application ${JSON.stringify(appPath)} to quit`],
        { env: buildBaseEnv(), timeout: 2500 },
      );
    } catch {
      // Fallback to SIGTERM below (e.g. non-Cocoa helper or headless bundle)
    }

    procs = await findAppProcessPids(appPath);
    if (procs.length > 0) {
      for (const pid of getMainBundleProcessPids(procs)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // already exited
        }
      }
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      procs = await findAppProcessPids(appPath);
      if (procs.length === 0) {
        options?.onAudit?.({
          id: auditId,
          timestamp: new Date().toISOString(),
          source: 'APP_LIFECYCLE',
          operation: `quit ${path.basename(appPath)}`,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          detail: 'Exited cleanly',
        });
        return;
      }
      await sleep(150);
    }

    // Force-kill straggler helper processes after graceful timeout
    for (const proc of procs) {
      try {
        process.kill(proc.pid, 'SIGKILL');
      } catch {
        // ignore
      }
    }

    const forceDeadline = Date.now() + 2500;
    while (Date.now() < forceDeadline) {
      procs = await findAppProcessPids(appPath);
      if (procs.length === 0) break;
      await sleep(100);
    }

    if (procs.length > 0) {
      throw new Error(
        `App did not exit cleanly; remaining PIDs: ${procs.map((p) => p.pid).join(', ')}`,
      );
    }

    options?.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `quit ${path.basename(appPath)}`,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      detail: 'Exited after SIGKILL fallback',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options?.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `quit ${path.basename(appPath)}`,
      status: 'error',
      durationMs: Date.now() - startedAt,
      detail: msg,
    });
    throw err;
  }
}

/**
 * Relaunch a macOS `.app` bundle via LaunchServices (`open -n -a`) with injected `--env` variables
 * and optional `--args` launch flags (such as `--remote-debugging-port=58321`).
 */
export async function launchAppWithEnv(
  appPath: string,
  envMap: Record<string, string>,
  options?: { launchArgs?: string[]; waitForExit?: boolean; onAudit?: AuditSink },
): Promise<void> {
  if (!fs.existsSync(appPath)) {
    throw new Error(`未找到应用程序: ${appPath}`);
  }

  const auditId = crypto.randomUUID();
  const startedAt = Date.now();
  const launchArgs = options?.launchArgs?.filter(Boolean) ?? [];
  const envSummary = Object.entries(envMap)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  const detailSummary =
    launchArgs.length > 0 ? `${envSummary} | args=${launchArgs.join(' ')}` : envSummary;

  options?.onAudit?.({
    id: auditId,
    timestamp: new Date().toISOString(),
    source: 'APP_LIFECYCLE',
    operation: `launch ${path.basename(appPath)}`,
    status: 'running',
    detail: detailSummary,
  });

  try {
    const args: string[] = [];
    if (options?.waitForExit) {
      args.push('-W');
    }
    args.push('-n', '-a', appPath);
    for (const [key, value] of Object.entries(envMap)) {
      args.push('--env', `${key}=${value}`);
    }
    if (launchArgs.length > 0) {
      args.push('--args', ...launchArgs);
    }

    await execFileAsync('/usr/bin/open', args, {
      env: buildBaseEnv(),
      timeout: options?.waitForExit ? 15000 : 10000,
    });

    options?.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `launch ${path.basename(appPath)}`,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      detail: detailSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    options?.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `launch ${path.basename(appPath)}`,
      status: 'error',
      durationMs: Date.now() - startedAt,
      detail: msg,
    });
    throw err;
  }
}

/**
 * Wait for `DevToolsActivePort` inside the isolated `profileHome` and mirror it into
 * the real user's `~/Library/Application Support/Antigravity/DevToolsActivePort` so
 * host-side daemons (e.g. Obsidian Prism) discover the switched Antigravity window automatically.
 */
export async function syncDevToolsActivePort(options: {
  profileHome: string;
  realHome?: string;
  minMtimeMs?: number;
  timeoutMs?: number;
  onAudit?: AuditSink;
}): Promise<number | null> {
  const realHome = options.realHome ?? os.homedir();
  const srcPath = path.join(
    options.profileHome,
    'Library',
    'Application Support',
    'Antigravity',
    'DevToolsActivePort',
  );
  const dstPath = path.join(
    realHome,
    'Library',
    'Application Support',
    'Antigravity',
    'DevToolsActivePort',
  );

  const timeoutMs = options.timeoutMs ?? 12000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (fs.existsSync(srcPath)) {
        const stat = fs.statSync(srcPath);
        if (!options.minMtimeMs || stat.mtimeMs >= options.minMtimeMs) {
          const content = fs.readFileSync(srcPath, 'utf8');
          const firstLine = content.split(/\r?\n/)[0]?.trim();
          const port = Number(firstLine);
          if (Number.isInteger(port) && port >= 1 && port <= 65535) {
            if (path.resolve(srcPath) !== path.resolve(dstPath)) {
              fs.mkdirSync(path.dirname(dstPath), { recursive: true });
              fs.writeFileSync(dstPath, content, 'utf8');
            }
            options.onAudit?.({
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              source: 'APP_LIFECYCLE',
              operation: 'sync DevToolsActivePort',
              status: 'ok',
              detail: `port=${port} -> ${dstPath}`,
            });
            return port;
          }
        }
      }
    } catch {
      // retry until deadline
    }
    await sleep(200);
  }

  return null;
}

const BLOCKED_CDP_URL_PREFIXES = [
  'devtools:',
  'data:',
  'about:',
  'chrome:',
  'chrome-extension:',
  'edge:',
  'blob:',
  'plugin:',
];

const EXCLUDED_LOOPBACK_PATH_RE = /^\/(?:viewer|sandbox|stream|api)(?:\/|$)/i;

/**
 * Identify whether a `/json/list` target represents a live Antigravity workbench page
 * rather than a splash `data:` page, sidecar `plugin:` iframe, or `devtools://` target.
 */
export function isAntigravityCdpPageTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false;
  const record = target as Record<string, unknown>;
  if (record.type !== 'page' || typeof record.url !== 'string') return false;
  const url = record.url.trim();
  if (!url) return false;

  const lowerUrl = url.toLowerCase();
  if (BLOCKED_CDP_URL_PREFIXES.some((prefix) => lowerUrl.startsWith(prefix))) {
    return false;
  }
  if (lowerUrl.startsWith('vscode-file://') || lowerUrl.startsWith('app://')) {
    return true;
  }
  if (lowerUrl.startsWith('file://')) {
    return /workbench|antigravity/i.test(lowerUrl);
  }

  const loopbackMatch =
    /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(\/[^?#]*)?(?:[?#]|$)/i.exec(url);
  if (!loopbackMatch) {
    return false;
  }
  const pathname = loopbackMatch[1] ?? '/';
  return !EXCLUDED_LOOPBACK_PATH_RE.test(pathname);
}

function fetchCdpTargets(port: number, timeoutMs = 1200): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        agent: false,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode ?? 0}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            resolve(Array.isArray(parsed) ? parsed : []);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('CDP /json/list timeout'));
    });
    req.on('error', reject);
  });
}

/**
 * Poll CDP `/json/list` until a real Antigravity workbench page appears, then wait briefly
 * so renderer scripts have mounted before attaching live-injection plugins.
 */
export async function waitForAntigravityCdpPage(
  port: number,
  options?: { timeoutMs?: number; pollIntervalMs?: number; settleDelayMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? 20000;
  const pollIntervalMs = options?.pollIntervalMs ?? 300;
  const settleDelayMs = options?.settleDelayMs ?? 1200;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const targets = await fetchCdpTargets(port, 1200);
      if (targets.some(isAntigravityCdpPageTarget)) {
        if (settleDelayMs > 0) {
          await sleep(settleDelayMs);
        }
        return true;
      }
    } catch {
      // CDP endpoint may not be accepting HTTP yet
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

/**
 * Prepend modern Homebrew Node directories inside `/bin/zsh -lc` after macOS `/etc/zprofile`
 * runs `path_helper` (which otherwise places `/usr/local/bin` before Homebrew kegs).
 */
export function buildHookShellCommand(
  command: string,
  preferredBinDirs: string[] = getPreferredRuntimeBinDirs(),
): string {
  if (preferredBinDirs.length === 0) {
    return command;
  }
  const joined = preferredBinDirs.join(':').replace(/'/g, "'\\''");
  return `export PATH='${joined}':"$PATH"; ${command}`;
}

function readHookLogTail(logPath: string, maxChars = 350): string {
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    // eslint-disable-next-line no-control-regex
    const stripped = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const normalized = stripped.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';
    return normalized.length > maxChars ? `...${normalized.slice(-maxChars)}` : normalized;
  } catch {
    return '';
  }
}

async function executeSingleHook(
  item: { name: string; command: string },
  options: { observeWindowMs: number; onAudit?: AuditSink },
): Promise<{ ok: boolean; name: string; detail: string }> {
  const trimmed = item.command.trim();
  const label = item.name.trim() || 'unnamed';
  const auditId = crypto.randomUUID();
  const startedAt = Date.now();

  options.onAudit?.({
    id: auditId,
    timestamp: new Date().toISOString(),
    source: 'APP_LIFECYCLE',
    operation: `post-restart hook: ${label}`,
    status: 'running',
    detail: trimmed,
  });

  const logDir = path.join(os.tmpdir(), 'agy-account-manager-hooks');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `${auditId}.log`);
  const shellCommand = buildHookShellCommand(trimmed);

  let logFd: number | null = null;
  let child: ReturnType<typeof spawn>;
  try {
    logFd = fs.openSync(logPath, 'w');
    child = spawn('/bin/zsh', ['-lc', shellCommand], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: buildBaseEnv(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fs.rmSync(logPath, { force: true });
    options.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `post-restart hook: ${label}`,
      status: 'error',
      durationMs: Date.now() - startedAt,
      detail: msg,
    });
    return { ok: false, name: label, detail: msg };
  } finally {
    if (logFd !== null) {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore fd close failure
      }
    }
  }

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; name: string; detail: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.unref();
      const tail = readHookLogTail(logPath);
      const detail = tail ? `后台运行中 (PID ${child.pid ?? 'unknown'}) | ${tail}` : `后台运行中 (PID ${child.pid ?? 'unknown'})`;
      options.onAudit?.({
        id: auditId,
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: `post-restart hook: ${label}`,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        detail,
      });
      finish({ ok: true, name: label, detail });
    }, options.observeWindowMs);

    child.once('error', (err) => {
      const tail = readHookLogTail(logPath);
      fs.rmSync(logPath, { force: true });
      const detail = tail ? `${err.message} | ${tail}` : err.message;
      options.onAudit?.({
        id: auditId,
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: `post-restart hook: ${label}`,
        status: 'error',
        durationMs: Date.now() - startedAt,
        detail,
      });
      finish({ ok: false, name: label, detail });
    });

    child.once('exit', (code, signal) => {
      const tail = readHookLogTail(logPath);
      fs.rmSync(logPath, { force: true });
      if (code === 0) {
        const detail = tail ? `${trimmed} | ${tail}` : trimmed;
        options.onAudit?.({
          id: auditId,
          timestamp: new Date().toISOString(),
          source: 'APP_LIFECYCLE',
          operation: `post-restart hook: ${label}`,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          detail,
        });
        finish({ ok: true, name: label, detail });
      } else {
        const exitDesc = code !== null ? `exit=${code}` : `signal=${signal ?? 'unknown'}`;
        const detail = tail ? `${exitDesc} | ${tail}` : exitDesc;
        options.onAudit?.({
          id: auditId,
          timestamp: new Date().toISOString(),
          source: 'APP_LIFECYCLE',
          operation: `post-restart hook: ${label}`,
          status: 'error',
          durationMs: Date.now() - startedAt,
          detail,
        });
        finish({ ok: false, name: label, detail });
      }
    });
  });
}

/**
 * Run one or more user-configured post-restart commands (e.g. hot-attaching Context Viewer
 * and Obsidian Prism) in the host user's normal environment once the workbench CDP page is ready.
 */
export async function runPostRestartCommands(
  items: Array<{ name: string; command: string; enabled: boolean }>,
  options?: {
    waitForPort?: number | null;
    hasCdpFlag?: boolean;
    profileHome?: string;
    realHome?: string;
    launchedAtMs?: number;
    cdpReadyTimeoutMs?: number;
    cdpSettleDelayMs?: number;
    hookObserveWindowMs?: number;
    fallbackDelayMs?: number;
    onAudit?: AuditSink;
  },
): Promise<PostRestartHooksResult> {
  const enabledItems = items.filter((item) => item.enabled && item.command.trim().length > 0);
  if (!options?.hasCdpFlag && enabledItems.length === 0) {
    return { total: 0, succeeded: 0, failed: [] };
  }

  let effectivePort =
    options?.waitForPort && options.waitForPort >= 1 ? options.waitForPort : null;

  if (options?.hasCdpFlag && options.profileHome) {
    const syncedPort = await syncDevToolsActivePort({
      profileHome: options.profileHome,
      realHome: options.realHome,
      minMtimeMs: options.launchedAtMs ? options.launchedAtMs - 1000 : undefined,
      timeoutMs: 12000,
      onAudit: options.onAudit,
    });
    if (!effectivePort && syncedPort) {
      effectivePort = syncedPort;
    }
  }

  if (enabledItems.length === 0) {
    return { total: 0, succeeded: 0, failed: [] };
  }

  if (effectivePort && effectivePort >= 1) {
    const pageReady = await waitForAntigravityCdpPage(effectivePort, {
      timeoutMs: options?.cdpReadyTimeoutMs ?? 20000,
      settleDelayMs: options?.cdpSettleDelayMs ?? 1200,
    });
    if (!pageReady) {
      options?.onAudit?.({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: 'wait CDP workbench page',
        status: 'error',
        detail: `端口 ${effectivePort} 在超时内未检测到 Antigravity 工作台页面，将回退直接尝试挂载`,
      });
      await waitForLoopbackPort(effectivePort, 4000);
      await sleep(1500);
    }
  } else {
    await sleep(options?.fallbackDelayMs ?? 1500);
  }

  const observeWindowMs = options?.hookObserveWindowMs ?? 12000;
  let succeeded = 0;
  const failed: Array<{ name: string; detail: string }> = [];

  for (const item of enabledItems) {
    const res = await executeSingleHook(item, {
      observeWindowMs,
      onAudit: options?.onAudit,
    });
    if (res.ok) {
      succeeded += 1;
    } else {
      failed.push({ name: res.name, detail: res.detail });
    }
  }

  return {
    total: enabledItems.length,
    succeeded,
    failed,
  };
}

export async function runPostRestartCommand(
  command: string,
  options?: {
    waitForPort?: number | null;
    fallbackDelayMs?: number;
    hookObserveWindowMs?: number;
    onAudit?: AuditSink;
  },
): Promise<PostRestartHooksResult> {
  return await runPostRestartCommands(
    [{ name: 'hook', command, enabled: true }],
    options,
  );
}
