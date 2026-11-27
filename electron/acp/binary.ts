import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const STANDARD_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

const PREFERRED_RUNTIME_BIN_CANDIDATES = [
  '/opt/homebrew/opt/node@24/bin',
  '/opt/homebrew/opt/node@22/bin',
  '/opt/homebrew/opt/node/bin',
  '/usr/local/opt/node@24/bin',
  '/usr/local/opt/node@22/bin',
  '/usr/local/opt/node/bin',
];

/**
 * Return existing modern Homebrew Node bin directories in priority order so
 * detached hook scripts pick Node 22+ instead of legacy `/usr/local/bin/node`.
 */
export function getPreferredRuntimeBinDirs(): string[] {
  return PREFERRED_RUNTIME_BIN_CANDIDATES.filter((dir) => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * Build a sanitized base environment for spawning official `agy` and macOS helper commands.
 */
export function buildBaseEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const home = os.homedir();
  const localBin = path.join(home, '.local', 'bin');
  const currentPath = process.env.PATH ?? '';
  const pathParts = [
    localBin,
    ...getPreferredRuntimeBinDirs(),
    ...STANDARD_PATHS,
    ...currentPath.split(path.delimiter),
  ].filter(Boolean);
  const dedupedPath = Array.from(new Set(pathParts)).join(path.delimiter);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: process.env.HOME || home,
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: process.env.TERM || 'xterm-256color',
    PATH: dedupedPath,
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the absolute path to the official `agy` CLI binary without shelling out.
 */
export function resolveAgyBinary(overridePath?: string): string | null {
  const trimmed = overridePath?.trim();
  if (trimmed) {
    const expanded = trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(2))
      : trimmed;
    return isExecutableFile(expanded) ? expanded : null;
  }

  const home = os.homedir();
  const candidates: string[] = [
    path.join(home, '.local', 'bin', 'agy'),
    '/opt/homebrew/bin/agy',
    '/usr/local/bin/agy',
  ];

  const envPath = process.env.PATH ?? '';
  for (const dir of envPath.split(path.delimiter)) {
    if (dir) {
      candidates.push(path.join(dir, 'agy'));
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Query `agy --version` directly.
 */
export async function getAgyVersion(agyPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(agyPath, ['--version'], {
      env: buildBaseEnv(),
      timeout: 8000,
    });
    const line = stdout.trim().split(/\r?\n/)[0]?.trim();
    return line || null;
  } catch {
    return null;
  }
}
