import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'docs', 'screenshots');

function buildDemoSnapshot(overrides = {}) {
  const accounts = [
    {
      id: 'slot-system-1',
      nickname: 'personal@example.com',
      emailHint: 'personal@example.com',
      note: '主账号（保留系统默认 HOME）',
      color: '#3b82f6',
      isolationMode: 'system',
      preferredAuthMode: 'oauth-personal',
      createdAt: '2026-11-26T08:30:00.000Z',
      lastVerifiedAt: '2026-11-27T04:05:10.000Z',
      lastSwitchedAt: '2026-11-26T16:12:00.000Z',
    },
    {
      id: '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34',
      nickname: 'studio-dev@workspace.io',
      emailHint: 'studio-dev@workspace.io',
      note: '日常开发独立环境（已缓存 ACP 会话）',
      color: '#10b981',
      isolationMode: 'isolated',
      preferredAuthMode: 'oauth-personal',
      createdAt: '2026-11-26T09:15:00.000Z',
      lastVerifiedAt: '2026-11-27T04:08:22.000Z',
      lastSwitchedAt: '2026-11-27T04:08:30.000Z',
    },
    {
      id: 'c31e4d07-91a2-4c88-b201-7f4e9012ad88',
      nickname: 'research-lab@example.org',
      emailHint: 'research-lab@example.org',
      note: '实验项目备用号',
      color: '#8b5cf6',
      isolationMode: 'isolated',
      preferredAuthMode: 'terminal-login',
      createdAt: '2026-11-27T01:20:00.000Z',
      lastVerifiedAt: '2026-11-27T03:42:18.000Z',
    },
  ];

  const settings = {
    agyPathOverride: '',
    antigravityAppPath: '/Applications/Antigravity.app',
    profilesRootDir: '/Users/developer/.antigravity-accounts/profiles',
    defaultAuthMode: 'oauth-personal',
    extraLaunchArgs: '--remote-debugging-port=58321',
    postRestartCommand: '',
    postRestartCommands: [
      {
        id: 'hook-prism',
        name: 'Obsidian Prism',
        command: 'cd ~/plugins/obsidian-prism && npm run inject',
        enabled: true,
      },
      {
        id: 'hook-context-viewer',
        name: 'Context Viewer',
        command: 'node ~/plugins/antigravity-context-viewer/cli.js live --no-launch',
        enabled: true,
      },
    ],
    shareConversationsAndProjects: true,
    shareGlobalCustomizations: true,
    symlinkShellConfig: true,
    autoRestoreActiveAccount: true,
    showTrayAccount: false,
    theme: 'dark',
  };

  const profileHome2 = '/Users/developer/.antigravity-accounts/profiles/8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34';
  const profileHome3 = '/Users/developer/.antigravity-accounts/profiles/c31e4d07-91a2-4c88-b201-7f4e9012ad88';

  const sessionStatuses = {
    'slot-system-1': {
      accountId: 'slot-system-1',
      authenticated: true,
      detectedEmail: 'personal@example.com',
      supportsLogout: true,
      checkedAt: '2026-11-27T04:05:10.000Z',
      profileHome: '/Users/developer',
      envPreview: {
        HOME: '/Users/developer',
        CFFIXED_USER_HOME: '/Users/developer',
        AGY_PROFILE_ID: 'slot-system-1',
        AGY_PROFILE_MODE: 'system',
      },
    },
    '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34': {
      accountId: '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34',
      authenticated: true,
      detectedEmail: 'studio-dev@workspace.io',
      supportsLogout: true,
      checkedAt: '2026-11-27T04:08:22.000Z',
      profileHome: profileHome2,
      envPreview: {
        HOME: profileHome2,
        CFFIXED_USER_HOME: profileHome2,
        XDG_CONFIG_HOME: `${profileHome2}/.config`,
        AGY_PROFILE_ID: '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34',
        AGY_PROFILE_MODE: 'isolated',
      },
    },
    'c31e4d07-91a2-4c88-b201-7f4e9012ad88': {
      accountId: 'c31e4d07-91a2-4c88-b201-7f4e9012ad88',
      authenticated: true,
      detectedEmail: 'research-lab@example.org',
      supportsLogout: true,
      checkedAt: '2026-11-27T03:42:18.000Z',
      profileHome: profileHome3,
      envPreview: {
        HOME: profileHome3,
        CFFIXED_USER_HOME: profileHome3,
        XDG_CONFIG_HOME: `${profileHome3}/.config`,
        AGY_PROFILE_ID: 'c31e4d07-91a2-4c88-b201-7f4e9012ad88',
        AGY_PROFILE_MODE: 'isolated',
      },
    },
  };

  const auditLog = [
    {
      id: 'audit-8',
      timestamp: '2026-11-27T04:08:36.420Z',
      source: 'APP_LIFECYCLE',
      operation: 'post-restart hook: Context Viewer',
      status: 'ok',
      durationMs: 412,
      detail: 'node ~/plugins/antigravity-context-viewer/cli.js live --no-launch | 已通过 CDP 热注入当前运行的 1/1 个 Antigravity 窗口',
    },
    {
      id: 'audit-7',
      timestamp: '2026-11-27T04:08:35.110Z',
      source: 'APP_LIFECYCLE',
      operation: 'post-restart hook: Obsidian Prism',
      status: 'ok',
      durationMs: 385,
      detail: 'cd ~/plugins/obsidian-prism && npm run inject | 调试端口 58321，发现 1 个窗口 (obsidian-prism · 状态: ok)',
    },
    {
      id: 'audit-6',
      timestamp: '2026-11-27T04:08:33.240Z',
      source: 'APP_LIFECYCLE',
      operation: 'sync DevToolsActivePort',
      status: 'ok',
      durationMs: 820,
      detail: 'port=58321 -> /Users/developer/Library/Application Support/Antigravity/DevToolsActivePort',
    },
    {
      id: 'audit-5',
      timestamp: '2026-11-27T04:08:31.500Z',
      source: 'APP_LIFECYCLE',
      operation: 'launch Antigravity.app',
      status: 'ok',
      durationMs: 295,
      detail: `HOME=${profileHome2}, CFFIXED_USER_HOME=${profileHome2} | args=--remote-debugging-port=58321`,
    },
    {
      id: 'audit-4',
      timestamp: '2026-11-27T04:08:29.880Z',
      source: 'APP_LIFECYCLE',
      operation: 'quit Antigravity.app',
      status: 'ok',
      durationMs: 1120,
      detail: 'Exited cleanly',
    },
    {
      id: 'audit-3',
      timestamp: '2026-11-27T04:08:22.410Z',
      source: 'ACP_RPC',
      operation: 'session/new (probe auth)',
      status: 'ok',
      durationMs: 188,
      detail: 'authenticated=true | email=studio-dev@workspace.io',
    },
    {
      id: 'audit-2',
      timestamp: '2026-11-27T04:08:22.120Z',
      source: 'ACP_RPC',
      operation: 'initialize',
      status: 'ok',
      durationMs: 96,
      detail: 'agy acp protocolVersion=1 (methods: oauth-personal, oauth-business, terminal-login)',
    },
    {
      id: 'audit-1',
      timestamp: '2026-11-27T04:08:21.540Z',
      source: 'ENV_ISOLATION',
      operation: 'prepare isolated env (studio-dev@workspace.io)',
      status: 'ok',
      durationMs: 164,
      detail: profileHome2,
    },
  ];

  return {
    accounts,
    activeAccountId: '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34',
    settings,
    runtimeInfo: {
      agyPath: '/Users/developer/.local/bin/agy',
      agyVersion: 'agy 1.18.4',
      acpServerVersion: '1.0.0',
      realHome: '/Users/developer',
      profilesRootDir: settings.profilesRootDir,
      checkedAt: '2026-11-27T04:08:22.000Z',
    },
    appStatus: {
      appPath: '/Applications/Antigravity.app',
      exists: true,
      running: true,
      pids: [41280, 41295, 41302],
      checkedAt: '2026-11-27T04:08:33.500Z',
    },
    sessionStatuses,
    auditLog,
    workflowState: {
      kind: 'idle',
      phase: 'idle',
      message: '',
    },
    updateState: {
      phase: 'idle',
      currentVersion: '1.0.2',
      releaseUrl: 'https://github.com/feiyuggg/antigravity-account-manager/releases',
      message: '',
    },
    isRefreshing: false,
    ...overrides,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureFrame(win, filename) {
  await win.webContents.executeJavaScript(
    'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 80))))',
  );
  await sleep(160);
  const image = await win.webContents.capturePage();
  const pngBuffer = image.toPNG();
  const outPath = path.join(OUT_DIR, filename);
  fs.writeFileSync(outPath, pngBuffer);
  const size = fs.statSync(outPath).size;
  console.log(`Captured ${filename}: ${size} bytes`);
  if (size < 20480) {
    throw new Error(`Screenshot ${filename} looks blank or too small (${size} bytes)`);
  }
}

app.whenReady().then(async () => {
  app.dock?.hide();
  nativeTheme.themeSource = 'dark';
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let currentState = buildDemoSnapshot();

  ipcMain.handle('state:get', () => currentState);
  ipcMain.handle('acp:refreshAll', () => currentState);
  ipcMain.handle('acp:probeAccount', () => currentState);
  ipcMain.handle('account:save', () => currentState);
  ipcMain.handle('account:quickAdd', () => undefined);
  ipcMain.handle('account:delete', () => currentState);
  ipcMain.handle('acp:loginStart', () => undefined);
  ipcMain.handle('app:switchAndRestart', () => undefined);
  ipcMain.handle('app:restartActive', () => undefined);
  ipcMain.handle('app:syncActiveToRunning', () => currentState);
  ipcMain.handle('app:runPostRestartHooks', () => ({
    snapshot: currentState,
    result: { total: 2, succeeded: 2, failed: [] },
  }));
  ipcMain.handle('app:checkForUpdates', () => currentState);
  ipcMain.handle('app:dismissUpdateNotice', () => currentState);
  ipcMain.handle('acp:submitCode', () => undefined);
  ipcMain.handle('workflow:cancel', () => undefined);
  ipcMain.handle('acp:logoutAccount', () => currentState);
  ipcMain.handle('settings:update', () => currentState);
  ipcMain.handle('shell:openProfileFolder', () => undefined);
  ipcMain.handle('audit:clear', () => currentState);
  ipcMain.handle('shell:openExternal', () => undefined);
  ipcMain.handle('clipboard:writeText', () => undefined);

  const win = new BrowserWindow({
    width: 1140,
    height: 820,
    show: false,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#0b0f19',
    title: 'Antigravity Account Manager',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      offscreen: true,
      preload: path.join(ROOT_DIR, 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const finishedLoad = new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve);
  });
  await win.loadFile(path.join(ROOT_DIR, 'dist', 'index.html'));
  await finishedLoad;
  await sleep(300);

  // 1. Dashboard with env drawer expanded on second card
  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent?.includes('隔离环境变量'));
    if (btns[1]) btns[1].click();
    else if (btns[0]) btns[0].click();
  })()`);
  await captureFrame(win, 'dashboard.png');

  // 2. Quick-add ACP browser login completion modal
  currentState = buildDemoSnapshot({
    workflowState: {
      kind: 'quick_add',
      phase: 'done',
      targetAccountId: '8f4a92c1-3b7e-4d12-9a50-6c18e2f09b34',
      authMode: 'oauth-personal',
      restartAfterLogin: false,
      autoCreatedAccount: true,
      detectedUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=agy-acp-demo',
      message: '已自动识别邮箱 studio-dev@workspace.io 并保存至独立隔离环境',
    },
  });
  win.webContents.send('state:updated', currentState);
  await captureFrame(win, 'quick-add-auth.png');

  // Close modal & switch to Settings tab
  currentState = buildDemoSnapshot();
  win.webContents.send('state:updated', currentState);
  await win.webContents.executeJavaScript(`(() => {
    const tabs = document.querySelectorAll('[role="tablist"] button');
    if (tabs[1]) tabs[1].click();
  })()`);
  await captureFrame(win, 'settings.png');

  // 4. Switch to Audit Log tab
  await win.webContents.executeJavaScript(`(() => {
    const tabs = document.querySelectorAll('[role="tablist"] button');
    if (tabs[2]) tabs[2].click();
  })()`);
  await captureFrame(win, 'audit-log.png');

  win.destroy();
  app.exit(0);
});
