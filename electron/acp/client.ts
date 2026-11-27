import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { AuditEntry, AuthMode } from '../../shared/types';
import { buildBaseEnv } from './binary';

export type AuditSink = (entry: AuditEntry) => void;

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name: string; version: string };
  agentCapabilities?: {
    auth?: { logout?: unknown };
  };
  authMethods?: Array<{
    id: string;
    name: string;
    description?: string;
    type?: string;
    args?: string[];
  }>;
}

export interface AcpAuthProbeResult {
  authenticated: boolean;
  email?: string;
}

const EMAIL_VALIDATION_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function extractAuthenticatedEmailFromLog(logText: string): string | undefined {
  const patterns = [
    /authenticated successfully as\s+([^\s,;]+@[^\s,;]+)/gi,
    /applyAuthResult:\s*email=([^\s,;]+@[^\s,;]+)/gi,
  ];
  let latestMatch: string | undefined;
  let latestIndex = -1;

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(logText)) !== null) {
      const candidate = match[1].trim();
      if (EMAIL_VALIDATION_REGEX.test(candidate) && match.index >= latestIndex) {
        latestIndex = match.index;
        latestMatch = candidate;
      }
    }
  }
  return latestMatch;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'AcpRpcError';
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  method: string;
  startedAt: number;
  auditId: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

function makeAuditEntry(
  source: AuditEntry['source'],
  operation: string,
  status: AuditEntry['status'],
  detail?: string,
  durationMs?: number,
  id?: string,
): AuditEntry {
  return {
    id: id ?? crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    source,
    operation,
    status,
    detail,
    durationMs,
  };
}

/**
 * Official Agent Client Protocol (ACP) JSON-RPC 2.0 client over stdio.
 * Communicates solely with `agy acp` inside the provided isolated profile env.
 * Never queries quota/credits endpoints and never inspects tokens or Keychain.
 */
export class AcpClient {
  private readonly agyPath: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly onAudit?: AuditSink;
  private readonly onAuthUrl?: (url: string) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrLines: string[] = [];
  private initResult: AcpInitializeResult | null = null;
  private closed = false;
  private tempLogFile: string | null = null;

  constructor(options: {
    agyPath: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    onAudit?: AuditSink;
    onAuthUrl?: (url: string) => void;
  }) {
    this.agyPath = options.agyPath;
    this.args = options.args ?? ['acp', '--disable-telemetry'];
    this.env = options.env ?? buildBaseEnv();
    this.onAudit = options.onAudit;
    this.onAuthUrl = options.onAuthUrl;
  }

  private emitAudit(entry: AuditEntry): void {
    this.onAudit?.(entry);
  }

  private maybeEmitAuthUrl(rawText: string): void {
    if (!this.onAuthUrl) return;
    const url = extractAuthUrl(rawText);
    if (url) {
      this.onAuthUrl(url);
    }
  }

  start(): void {
    if (this.child) return;
    this.closed = false;

    const spawnArgs = [...this.args];
    if (!spawnArgs.includes('--log-file')) {
      this.tempLogFile = path.join(
        os.tmpdir(),
        `agy-acp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.log`,
      );
      spawnArgs.push('--log-file', this.tempLogFile);
    }

    const child = spawn(this.agyPath, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.env,
    });
    this.child = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.rl = rl;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        this.maybeEmitAuthUrl(trimmed);
        return;
      }

      const id = msg.id;
      if (typeof id === 'number' && this.pending.has(id)) {
        const req = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(req.timer);
        const durationMs = Date.now() - req.startedAt;

        if (msg.error && typeof msg.error === 'object') {
          const errObj = msg.error as { code?: unknown; message?: unknown; data?: unknown };
          const code = typeof errObj.code === 'number' ? errObj.code : -32603;
          const message =
            typeof errObj.message === 'string' ? errObj.message : 'ACP JSON-RPC error';
          this.emitAudit(
            makeAuditEntry(
              'ACP_RPC',
              req.method,
              'error',
              `[${code}] ${message}`,
              durationMs,
              req.auditId,
            ),
          );
          req.reject(new AcpRpcError(code, message, errObj.data));
        } else {
          this.emitAudit(
            makeAuditEntry('ACP_RPC', req.method, 'ok', undefined, durationMs, req.auditId),
          );
          req.resolve(msg.result);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) {
        this.maybeEmitAuthUrl(text);
        this.stderrLines.push(text);
        if (this.stderrLines.length > 50) {
          this.stderrLines.shift();
        }
      }
    });

    child.on('exit', (code, signal) => {
      const reason =
        this.stderrLines.slice(-3).join(' | ') ||
        `ACP subprocess exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})`;
      for (const [id, req] of this.pending.entries()) {
        clearTimeout(req.timer);
        this.pending.delete(id);
        const durationMs = Date.now() - req.startedAt;
        this.emitAudit(
          makeAuditEntry('ACP_RPC', req.method, 'error', reason, durationMs, req.auditId),
        );
        req.reject(new Error(reason));
      }
    });

    child.on('error', (err) => {
      for (const [id, req] of this.pending.entries()) {
        clearTimeout(req.timer);
        this.pending.delete(id);
        req.reject(err);
      }
    });
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    options?: { timeoutMs?: number; signal?: AbortSignal; auditDetail?: string },
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('ACP client is already closed'));
    }
    this.start();
    const child = this.child;
    if (!child || !child.stdin.writable) {
      return Promise.reject(new Error('ACP stdin is not writable'));
    }

    const id = this.nextId++;
    const timeoutMs = options?.timeoutMs ?? 15000;
    const auditId = crypto.randomUUID();
    const startedAt = Date.now();

    this.emitAudit(
      makeAuditEntry('ACP_RPC', method, 'running', options?.auditDetail, undefined, auditId),
    );

    return new Promise<T>((resolve, reject) => {
      const cleanupAbort = () => {
        options?.signal?.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        const durationMs = Date.now() - startedAt;
        this.emitAudit(
          makeAuditEntry('ACP_RPC', method, 'error', 'Cancelled by user', durationMs, auditId),
        );
        reject(new Error('Cancelled by user'));
      };

      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        cleanupAbort();
        const durationMs = Date.now() - startedAt;
        this.emitAudit(
          makeAuditEntry(
            'ACP_RPC',
            method,
            'error',
            `Timed out after ${timeoutMs}ms`,
            durationMs,
            auditId,
          ),
        );
        reject(new Error(`ACP request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      if (options?.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer);
          reject(new Error('Cancelled by user'));
          return;
        }
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(id, {
        method,
        startedAt,
        auditId,
        timer,
        resolve: (val) => {
          cleanupAbort();
          resolve(val as T);
        },
        reject: (err) => {
          cleanupAbort();
          reject(err);
        },
      });

      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      child.stdin.write(`${payload}\n`);
    });
  }

  async initialize(): Promise<AcpInitializeResult> {
    const res = await this.request<AcpInitializeResult>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          auth: { terminal: true },
        },
        clientInfo: {
          name: 'antigravity-account-manager',
          version: '1.0.0',
        },
      },
      { timeoutMs: 15000 },
    );
    this.initResult = res;
    return res;
  }

  private readDetectedEmailFromLog(): string | undefined {
    if (!this.tempLogFile) return undefined;
    try {
      if (!fs.existsSync(this.tempLogFile)) return undefined;
      const logText = fs.readFileSync(this.tempLogFile, 'utf8');
      return extractAuthenticatedEmailFromLog(logText);
    } catch {
      return undefined;
    }
  }

  /**
   * Probe ONLY whether this isolated profile's `agy acp` session is authenticated.
   * Immediately closes the probe session and extracts only the signed-in email if logged by ACP.
   */
  async probeAuthStatus(probeCwd: string): Promise<AcpAuthProbeResult> {
    fs.mkdirSync(probeCwd, { recursive: true });
    try {
      const res = await this.request<{ sessionId?: string }>(
        'session/new',
        { cwd: probeCwd, mcpServers: [] },
        { timeoutMs: 20000, auditDetail: 'probe auth status' },
      );

      if (res.sessionId) {
        try {
          await this.request('session/close', { sessionId: res.sessionId }, { timeoutMs: 5000 });
        } catch {
          // Non-fatal: server closes sessions on exit as well.
        }
      }

      let email = this.readDetectedEmailFromLog();
      if (!email) {
        await new Promise((r) => setTimeout(r, 60));
        email = this.readDetectedEmailFromLog();
      }

      return { authenticated: true, email };
    } catch (err) {
      if (
        err instanceof AcpRpcError &&
        (err.code === -32000 || /authentication required/i.test(err.message))
      ) {
        return { authenticated: false };
      }
      throw err;
    }
  }

  /**
   * Invoke ACP `logout` (with `auth/logout` fallback only on -32601 Method not found).
   */
  async logout(): Promise<void> {
    if (!this.initResult) {
      await this.initialize();
    }
    const authCap = this.initResult?.agentCapabilities?.auth;
    if (!authCap || authCap.logout === undefined) {
      throw new Error('ACP server did not advertise auth.logout capability');
    }

    try {
      await this.request('logout', {}, { timeoutMs: 15000 });
    } catch (err) {
      if (err instanceof AcpRpcError && err.code === -32601) {
        await this.request('auth/logout', {}, { timeoutMs: 15000 });
        return;
      }
      throw err;
    }
  }

  /**
   * Invoke ACP `authenticate` for browser-based OAuth (`oauth-personal` or `oauth-business`).
   */
  async authenticate(
    methodId: Exclude<AuthMode, 'terminal-login'>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      'authenticate',
      { methodId },
      { timeoutMs: 180000, signal, auditDetail: `methodId=${methodId}` },
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer);
      this.pending.delete(id);
      req.reject(new Error('ACP client closed'));
    }

    this.rl?.close();
    this.rl = null;

    const child = this.child;
    this.child = null;

    const cleanupLog = () => {
      if (!this.tempLogFile) return;
      try {
        fs.rmSync(this.tempLogFile, { force: true });
      } catch {
        // ignore cleanup error
      }
      this.tempLogFile = null;
    };

    if (!child) {
      cleanupLog();
      return;
    }

    try {
      child.stdin.end();
    } catch {
      // ignore
    }

    if (child.exitCode === null && !child.killed) {
      await new Promise<void>((resolve) => {
        const forceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 1200);

        child.once('exit', () => {
          clearTimeout(forceTimer);
          resolve();
        });

        try {
          child.kill('SIGTERM');
        } catch {
          clearTimeout(forceTimer);
          resolve();
        }
      });
    }

    cleanupLog();
  }
}

const ANSI_REGEX = /\u001b\[[0-9;]*[a-zA-Z]/g;
const URL_REGEX = /https:\/\/[^\s"'<>]+/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

export function extractAuthUrl(text: string): string | undefined {
  const matches = stripAnsi(text).match(URL_REGEX);
  if (!matches || matches.length === 0) return undefined;
  const googleUrl = matches.find((u) => u.includes('accounts.google.com'));
  return googleUrl ?? matches[0];
}

/**
 * Out-of-band ACP `terminal` authentication handler (`agy acp --login`).
 * Per ACP spec, `type: "terminal"` auth methods are executed directly as a subprocess
 * inside the target profile's isolated environment.
 */
export class TerminalLoginSession {
  private readonly agyPath: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly onAudit?: AuditSink;
  private child: ChildProcessWithoutNullStreams | null = null;
  private outputBuffer = '';
  private detectedUrl: string | undefined;
  private cancelled = false;

  constructor(options: {
    agyPath: string;
    args?: string[];
    env?: NodeJS.ProcessEnv;
    onAudit?: AuditSink;
  }) {
    this.agyPath = options.agyPath;
    this.args = options.args ?? ['acp', '--login'];
    this.env = options.env ?? buildBaseEnv();
    this.onAudit = options.onAudit;
  }

  start(handlers: {
    onOutput: (fullOutput: string, detectedUrl?: string) => void;
  }): Promise<void> {
    const auditId = crypto.randomUUID();
    const startedAt = Date.now();
    this.onAudit?.(
      makeAuditEntry(
        'ACP_TERMINAL',
        `spawn ${this.args.join(' ')}`,
        'running',
        undefined,
        undefined,
        auditId,
      ),
    );

    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.agyPath, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });
      this.child = child;

      const handleChunk = (chunk: Buffer) => {
        const clean = stripAnsi(chunk.toString('utf8'));
        this.outputBuffer += clean;
        const url = extractAuthUrl(this.outputBuffer);
        if (url) {
          this.detectedUrl = url;
        }
        handlers.onOutput(this.outputBuffer, this.detectedUrl);
      };

      child.stdout.on('data', handleChunk);
      child.stderr.on('data', handleChunk);

      child.on('error', (err) => {
        this.onAudit?.(
          makeAuditEntry(
            'ACP_TERMINAL',
            `spawn ${this.args.join(' ')}`,
            'error',
            err.message,
            Date.now() - startedAt,
            auditId,
          ),
        );
        reject(err);
      });

      child.on('exit', (code) => {
        const durationMs = Date.now() - startedAt;
        if (this.cancelled) {
          this.onAudit?.(
            makeAuditEntry(
              'ACP_TERMINAL',
              `spawn ${this.args.join(' ')}`,
              'error',
              'Cancelled by user',
              durationMs,
              auditId,
            ),
          );
          reject(new Error('Cancelled by user'));
          return;
        }
        if (code === 0) {
          this.onAudit?.(
            makeAuditEntry(
              'ACP_TERMINAL',
              `spawn ${this.args.join(' ')}`,
              'ok',
              'Terminal login completed',
              durationMs,
              auditId,
            ),
          );
          resolve();
        } else {
          const tail = this.outputBuffer.trim().split(/\r?\n/).slice(-3).join(' | ');
          const msg = tail || `agy acp --login exited with code ${code ?? 'null'}`;
          this.onAudit?.(
            makeAuditEntry(
              'ACP_TERMINAL',
              `spawn ${this.args.join(' ')}`,
              'error',
              msg,
              durationMs,
              auditId,
            ),
          );
          reject(new Error(msg));
        }
      });
    });
  }

  submitCode(code: string): void {
    const trimmed = code.trim();
    if (!trimmed) {
      throw new Error('授权码不能为空');
    }
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('终端登录进程当前未处于可输入状态');
    }
    this.child.stdin.write(`${trimmed}\n`);
  }

  cancel(): void {
    this.cancelled = true;
    if (!this.child) return;
    try {
      this.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
}
