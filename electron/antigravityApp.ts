import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AntigravityAppStatus, AuditEntry } from '../shared/types';
import { buildBaseEnv } from './acp/binary';

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

/**
 * Run one or more user-configured post-restart commands (e.g. hot-attaching Context Viewer
 * and Obsidian Prism) in the host user's normal environment once the target CDP port is ready.
 */
export async function runPostRestartCommands(
  items: Array<{ name: string; command: string; enabled: boolean }>,
  options?: {
    waitForPort?: number | null;
    hasCdpFlag?: boolean;
    profileHome?: string;
    realHome?: string;
    launchedAtMs?: number;
    fallbackDelayMs?: number;
    onAudit?: AuditSink;
  },
): Promise<void> {
  const enabledItems = items.filter((item) => item.enabled && item.command.trim().length > 0);
  if (!options?.hasCdpFlag && enabledItems.length === 0) {
    return;
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
    return;
  }

  if (effectivePort && effectivePort >= 1) {
    await waitForLoopbackPort(effectivePort, 8000);
    await sleep(500);
  } else {
    await sleep(options?.fallbackDelayMs ?? 1500);
  }

  for (const item of enabledItems) {
    const trimmed = item.command.trim();
    const label = item.name.trim() || 'unnamed';
    const auditId = crypto.randomUUID();
    const startedAt = Date.now();

    options?.onAudit?.({
      id: auditId,
      timestamp: new Date().toISOString(),
      source: 'APP_LIFECYCLE',
      operation: `post-restart hook: ${label}`,
      status: 'running',
      detail: trimmed,
    });

    try {
      const child = spawn('/bin/zsh', ['-lc', trimmed], {
        detached: true,
        stdio: 'ignore',
        env: buildBaseEnv(),
      });
      child.unref();

      options?.onAudit?.({
        id: auditId,
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: `post-restart hook: ${label}`,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        detail: trimmed,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      options?.onAudit?.({
        id: auditId,
        timestamp: new Date().toISOString(),
        source: 'APP_LIFECYCLE',
        operation: `post-restart hook: ${label}`,
        status: 'error',
        durationMs: Date.now() - startedAt,
        detail: msg,
      });
    }
  }
}

export async function runPostRestartCommand(
  command: string,
  options?: { waitForPort?: number | null; fallbackDelayMs?: number; onAudit?: AuditSink },
): Promise<void> {
  await runPostRestartCommands(
    [{ name: 'hook', command, enabled: true }],
    options,
  );
}
