#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
const logFileIndex = args.indexOf('--log-file');
const logFilePath = logFileIndex !== -1 ? args[logFileIndex + 1] : undefined;

if (process.env.MOCK_ENV_RECORD_FILE) {
  fs.writeFileSync(
    process.env.MOCK_ENV_RECORD_FILE,
    JSON.stringify({
      HOME: process.env.HOME,
      CFFIXED_USER_HOME: process.env.CFFIXED_USER_HOME,
      AGY_PROFILE_ID: process.env.AGY_PROFILE_ID,
      AGY_PROFILE_MODE: process.env.AGY_PROFILE_MODE,
    }),
    'utf8',
  );
}

// Mock `agy acp --login` terminal authentication flow
if (args.includes('--login')) {
  process.stdout.write(
    'Open this link in a browser to log in with Google:\n' +
      'https://accounts.google.com/o/oauth2/auth?client_id=mock-client&scope=openid\n' +
      'Enter authorization code: ',
  );

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.once('line', (line) => {
    const code = line.trim();
    if (code === 'valid-code-123') {
      process.stdout.write('Login succeeded!\n');
      process.exit(0);
    } else {
      process.stderr.write(`Invalid authorization code: ${code}\n`);
      process.exit(1);
    }
  });
} else {
  // Mock `agy acp` JSON-RPC 2.0 stdio server
  let authenticated = process.env.MOCK_AUTHENTICATED !== '0';
  const useAuthLogoutFallback = process.env.MOCK_AUTH_LOGOUT_FALLBACK === '1';

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  function reply(id, result) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  }

  function replyError(id, code, message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  }

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = req;

    if (method === 'initialize') {
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          auth: { logout: {} },
        },
        agentInfo: { name: 'Mock Antigravity ACP Server', version: '1.5.17-mock' },
        authMethods: [
          { id: 'oauth-personal', name: 'Log in with Google' },
          { id: 'oauth-business', name: 'Log in with Gemini Enterprise' },
          {
            id: 'terminal-login',
            name: 'Log in from the terminal',
            type: 'terminal',
            args: ['--login'],
          },
        ],
      });
      return;
    }

    if (method === 'session/new') {
      if (!authenticated) {
        replyError(id, -32000, 'Authentication required');
        return;
      }
      if (logFilePath) {
        fs.appendFileSync(
          logFilePath,
          'I1127 10:58:33.697559 26 server_oauth.go:226] OAuth: authenticated successfully as mock.user@gmail.com\n',
          'utf8',
        );
      }
      reply(id, { sessionId: 'mock-session-001' });
      return;
    }

    if (method === 'session/close') {
      reply(id, {});
      return;
    }

    if (method === 'logout') {
      if (useAuthLogoutFallback) {
        replyError(id, -32601, 'Method not found');
        return;
      }
      authenticated = false;
      reply(id, {});
      return;
    }

    if (method === 'auth/logout') {
      authenticated = false;
      reply(id, {});
      return;
    }

    if (method === 'authenticate') {
      if (params?.methodId === 'oauth-personal' || params?.methodId === 'oauth-business') {
        if (params?.methodId === 'oauth-personal') {
          process.stderr.write(
            'Opening browser: https://accounts.google.com/o/oauth2/auth?client_id=mock-browser-client\n',
          );
        }
        setTimeout(() => {
          authenticated = true;
          reply(id, {});
        }, 30);
        return;
      }
      replyError(id, -32602, `Unsupported methodId: ${params?.methodId}`);
      return;
    }

    replyError(id, -32601, `Method not found: ${method}`);
  });
}
