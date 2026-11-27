import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
} from 'electron';
import type {
  AccountProfile,
  AccountSaveInput,
  AntigravityAppStatus,
  AppSettings,
  AppStateSnapshot,
  AuditEntry,
  AuthMode,
  LoginStartInput,
  PostRestartCommandItem,
  PostRestartHooksResult,
  ProfileSessionStatus,
  RuntimeInfo,
  SwitchStartInput,
  WorkflowState,
} from '../shared/types';
import { getAgyVersion, resolveAgyBinary } from './acp/binary';
import { AcpClient, TerminalLoginSession } from './acp/client';
import {
  extractPreservedLaunchArgs,
  extractRemoteDebuggingPort,
  findAppProcessPids,
  getAntigravityAppStatus,
  hasRemoteDebuggingPortFlag,
  launchAppWithEnv,
  mergeLaunchArgs,
  parseLaunchArgs,
  quitAppGracefully,
  runPostRestartCommands,
} from './antigravityApp';
import {
  buildProfileEnv,
  ensureIsolatedProfileReady,
  getProfileHomeDir,
  removeIsolatedProfileDir,
} from './envIsolation';
import { generateNextAccountDefaults, ProfileStore } from './store';
import { formatTrayMenuAccountLabel, formatTraySlotBadge } from './trayLabel';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let store: ProfileStore;
let runtimeInfo: RuntimeInfo | null = null;
let appStatus: AntigravityAppStatus | null = null;
let sessionStatuses: Record<string, ProfileSessionStatus> = {};
let auditLog: AuditEntry[] = [];
let isRefreshing = false;

let workflowState: WorkflowState = {
  kind: 'idle',
  phase: 'idle',
  message: '',
};
let activeWorkflowAbort: AbortController | null = null;
let activeTerminalSession: TerminalLoginSession | null = null;

const MAX_AUDIT_ENTRIES = 250;

function createTrayTemplateIcon(): Electron.NativeImage {
  const size = 18;
  const raw = Buffer.alloc(size * (1 + size * 4), 0);

  const setPixel = (x: number, y: number, alpha: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const rowOffset = y * (1 + size * 4);
    const px = rowOffset + 1 + x * 4;
    raw[px] = 0;
    raw[px + 1] = 0;
    raw[px + 2] = 0;
    raw[px + 3] = Math.max(raw[px + 3], Math.min(255, Math.round(alpha)));
  };

  for (let y = 2; y <= 15; y++) {
    for (let x = 2; x <= 15; x++) {
      const dx = x - 8.5;
      const dy = y - 8.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= 5.6 && r <= 7.2) {
        setPixel(x, y, 240);
      }
    }
  }
  for (let x = 5; x <= 12; x++) setPixel(x, 6, 255);
  setPixel(11, 5, 255);
  setPixel(10, 4, 255);
  setPixel(11, 7, 255);
  for (let x = 5; x <= 12; x++) setPixel(x, 11, 255);
  setPixel(6, 10, 255);
  setPixel(7, 13, 255);
  setPixel(6, 12, 255);

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);

  const img = nativeImage.createFromBuffer(png);
  img.setTemplateImage(true);
  return img;
}

function recordAudit(entry: AuditEntry): void {
  const idx = auditLog.findIndex((item) => item.id === entry.id);
  if (idx !== -1) {
    auditLog[idx] = entry;
  } else {
    auditLog.unshift(entry);
    if (auditLog.length > MAX_AUDIT_ENTRIES) {
      auditLog = auditLog.slice(0, MAX_AUDIT_ENTRIES);
    }
  }
  broadcastState();
}

function getProbeCwd(): string {
  return path.join(app.getPath('userData'), 'probe-workspace');
}

function getSnapshotState(): AppStateSnapshot {
  const data = store.getState();
  return {
    accounts: data.accounts,
    activeAccountId: data.activeAccountId,
    settings: data.settings,
    runtimeInfo,
    appStatus,
    sessionStatuses: { ...sessionStatuses },
    auditLog: [...auditLog],
    workflowState: { ...workflowState },
    isRefreshing,
  };
}

function broadcastState(): void {
  const snapshot = getSnapshotState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('state:updated', snapshot);
  }
  updateTray();
}

function isWorkflowRunning(): boolean {
  return (
    workflowState.phase !== 'idle' &&
    workflowState.phase !== 'done' &&
    workflowState.phase !== 'error' &&
    workflowState.phase !== 'cancelled'
  );
}

function updateTray(): void {
  if (!tray) return;
  const data = store.getState();
  const activeIdx = data.activeAccountId
    ? data.accounts.findIndex((a) => a.id === data.activeAccountId)
    : -1;
  const active = activeIdx >= 0 ? data.accounts[activeIdx] : undefined;
  const activeSlotIndex = activeIdx >= 0 ? activeIdx + 1 : null;

  tray.setToolTip(
    active
      ? `Antigravity Account Manager · ${active.nickname}${active.emailHint && active.emailHint !== active.nickname ? ` (${active.emailHint})` : ''}`
      : 'Antigravity Account Manager',
  );

  if (data.settings.showTrayAccount) {
    tray.setTitle(formatTraySlotBadge(activeSlotIndex), { fontType: 'monospaced' });
  } else {
    tray.setTitle('');
  }

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label:
        active && activeSlotIndex
          ? `当前：${formatTrayMenuAccountLabel(active.nickname, activeSlotIndex, active.emailHint)}`
          : '当前：未激活账号',
      enabled: false,
    },
    {
      label: appStatus?.running ? 'Antigravity 运行中' : 'Antigravity 未运行',
      enabled: false,
    },
    { type: 'separator' },
  ];

  if (data.accounts.length > 0) {
    menuItems.push({
      label: '切换账号',
      submenu: data.accounts.map((acc, idx) => {
        const status = sessionStatuses[acc.id];
        const readyTag = status?.authenticated ? '✓' : '○';
        return {
          label: `${acc.id === data.activeAccountId ? '● ' : '   '}#${idx + 1} ${acc.nickname}  ${readyTag}`,
          enabled: !isWorkflowRunning(),
          click: () => {
            showMainWindow();
            void startSwitchAndRestart({ accountId: acc.id });
          },
        };
      }),
    });
  } else {
    menuItems.push({
      label: '暂无账号槽位，请先添加',
      enabled: false,
    });
  }

  menuItems.push(
    {
      label: '添加账号（浏览器 ACP 认证）',
      enabled: !isWorkflowRunning(),
      click: () => {
        showMainWindow();
        void startQuickAddAccount({ restartAfterLogin: false });
      },
    },
    {
      label: isRefreshing ? '正在刷新状态...' : '刷新状态',
      enabled: !isRefreshing && !isWorkflowRunning(),
      click: () => {
        void refreshAll();
      },
    },
    { type: 'separator' },
    {
      label: '状态栏显示槽位编号 (#1/#2)',
      type: 'checkbox',
      checked: data.settings.showTrayAccount,
      click: (item) => {
        store.updateSettings({ showTrayAccount: item.checked });
        broadcastState();
      },
    },
    {
      label: '打开主面板',
      click: () => showMainWindow(),
    },
    {
      label: '退出',
      click: () => app.quit(),
    },
  );

  tray.setContextMenu(Menu.buildFromTemplate(menuItems));
}

async function probeAccountInternal(
  account: AccountProfile,
  agyPath: string,
  settings: AppSettings,
): Promise<ProfileSessionStatus> {
  const built =
    account.isolationMode === 'isolated'
      ? await ensureIsolatedProfileReady(account, {
          profilesRootDir: settings.profilesRootDir,
          shareConversationsAndProjects: settings.shareConversationsAndProjects,
          shareGlobalCustomizations: settings.shareGlobalCustomizations,
          symlinkShellConfig: settings.symlinkShellConfig,
          onAudit: recordAudit,
        })
      : buildProfileEnv(account, { profilesRootDir: settings.profilesRootDir });

  const client = new AcpClient({
    agyPath,
    env: built.env,
    onAudit: recordAudit,
  });

  try {
    const initRes = await client.initialize();
    const probe = await client.probeAuthStatus(getProbeCwd());
    if (probe.authenticated) {
      store.markVerified(account.id);
      if (probe.email) {
        store.syncDetectedIdentity(account.id, probe.email);
      }
    }

    if (runtimeInfo && !runtimeInfo.acpServerVersion && initRes.agentInfo?.version) {
      runtimeInfo = {
        ...runtimeInfo,
        acpServerVersion: initRes.agentInfo.version,
      };
    }

    const status: ProfileSessionStatus = {
      accountId: account.id,
      authenticated: probe.authenticated,
      detectedEmail: probe.email,
      supportsLogout: initRes.agentCapabilities?.auth?.logout !== undefined,
      checkedAt: new Date().toISOString(),
      profileHome: built.profileHome,
      envPreview: built.envPreview,
    };
    sessionStatuses[account.id] = status;
    return status;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status: ProfileSessionStatus = {
      accountId: account.id,
      authenticated: false,
      supportsLogout: false,
      checkedAt: new Date().toISOString(),
      profileHome: built.profileHome,
      envPreview: built.envPreview,
      error: msg,
    };
    sessionStatuses[account.id] = status;
    return status;
  } finally {
    await client.close();
  }
}

async function refreshAll(): Promise<AppStateSnapshot> {
  if (isRefreshing) {
    return getSnapshotState();
  }
  isRefreshing = true;
  broadcastState();

  try {
    const settings = store.getSettings();
    const agyPath = resolveAgyBinary(settings.agyPathOverride);
    const agyVersion = agyPath ? await getAgyVersion(agyPath) : null;
    appStatus = await getAntigravityAppStatus(settings.antigravityAppPath);

    runtimeInfo = {
      agyPath,
      agyVersion,
      acpServerVersion: runtimeInfo?.acpServerVersion ?? null,
      realHome: os.homedir(),
      profilesRootDir: settings.profilesRootDir,
      checkedAt: new Date().toISOString(),
      error: agyPath ? undefined : '未找到官方 agy CLI 可执行文件，请在设置中检查路径。',
    };

    if (agyPath) {
      const accounts = store.listAccounts();
      for (const acc of accounts) {
        await probeAccountInternal(acc, agyPath, settings);
        broadcastState();
      }
    }

    return getSnapshotState();
  } finally {
    isRefreshing = false;
    broadcastState();
  }
}

async function probeSingleAccount(accountId: string): Promise<AppStateSnapshot> {
  const settings = store.getSettings();
  const agyPath = resolveAgyBinary(settings.agyPathOverride);
  const account = store.getAccount(accountId);
  if (!account) {
    throw new Error('目标账号槽位不存在');
  }
  appStatus = await getAntigravityAppStatus(settings.antigravityAppPath);
  if (!agyPath) {
    throw new Error('未找到官方 agy CLI 可执行文件');
  }
  await probeAccountInternal(account, agyPath, settings);
  broadcastState();
  return getSnapshotState();
}

async function executeAcpLoginInProfile(
  target: AccountProfile,
  authMode: AuthMode,
  agyPath: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
): Promise<void> {
  if (authMode === 'terminal-login') {
    let terminalArgs = ['acp', '--login'];
    const probeClient = new AcpClient({ agyPath, env, onAudit: recordAudit });
    try {
      const initRes = await probeClient.initialize();
      const termMethod = initRes.authMethods?.find((m) => m.id === 'terminal-login');
      if (termMethod?.args?.length) {
        terminalArgs = ['acp', ...termMethod.args];
      }
    } catch {
      // keep default ['acp', '--login']
    } finally {
      await probeClient.close();
    }

    workflowState = {
      ...workflowState,
      phase: 'awaiting_auth',
      authMode,
      message: `已在该槽位隔离环境中启动官方 agy acp --login，请打开授权链接登录「${target.nickname}」${target.emailHint ? ` (${target.emailHint})` : ''} 并粘贴授权码...`,
      terminalOutput: '正在等待官方 agy acp --login 输出授权链接...\n',
    };
    broadcastState();

    const termSession = new TerminalLoginSession({
      agyPath,
      args: terminalArgs,
      env,
      onAudit: recordAudit,
    });
    activeTerminalSession = termSession;
    try {
      await termSession.start({
        onOutput: (fullOutput, detectedUrl) => {
          workflowState = {
            ...workflowState,
            terminalOutput: fullOutput,
            detectedUrl: detectedUrl ?? workflowState.detectedUrl,
          };
          broadcastState();
        },
      });
    } finally {
      activeTerminalSession = null;
    }
    return;
  }

  workflowState = {
    ...workflowState,
    phase: 'awaiting_auth',
    authMode,
    message: `官方 agy acp 已拉起浏览器登录，请完成「${target.nickname}」${target.emailHint ? ` (${target.emailHint})` : ''} 的授权...`,
  };
  broadcastState();

  const authClient = new AcpClient({
    agyPath,
    env,
    onAudit: recordAudit,
    onAuthUrl: (url) => {
      if (workflowState.detectedUrl !== url) {
        workflowState = {
          ...workflowState,
          detectedUrl: url,
        };
        broadcastState();
      }
    },
  });
  try {
    await authClient.initialize();
    await authClient.authenticate(authMode, signal);
  } finally {
    await authClient.close();
  }
}

function getEffectivePostRestartCommands(settings: AppSettings): PostRestartCommandItem[] {
  if (settings.postRestartCommands && settings.postRestartCommands.length > 0) {
    return settings.postRestartCommands;
  }
  if (settings.postRestartCommand.trim()) {
    return [
      {
        id: 'legacy-post-cmd',
        name: '重启后命令',
        command: settings.postRestartCommand.trim(),
        enabled: true,
      },
    ];
  }
  return [];
}

function formatHookWarningSuffix(hooksResult?: PostRestartHooksResult): string {
  if (!hooksResult || hooksResult.failed.length === 0) return '';
  const failedNames = hooksResult.failed.map((f) => f.name).join('、');
  return `（⚠️ ${hooksResult.failed.length} 个插件命令执行失败：${failedNames}，请在「ACP 审计日志」查看详情）`;
}

async function restartAntigravityForAccount(
  target: AccountProfile,
  settings: AppSettings,
  envPreview: Record<string, string>,
): Promise<PostRestartHooksResult> {
  if (!fs.existsSync(settings.antigravityAppPath)) {
    throw new Error(`未找到 Antigravity 应用: ${settings.antigravityAppPath}`);
  }

  let preservedArgs: string[] = [];
  try {
    const runningProcs = await findAppProcessPids(settings.antigravityAppPath);
    preservedArgs = extractPreservedLaunchArgs(runningProcs);
  } catch {
    preservedArgs = [];
  }
  const launchArgs = mergeLaunchArgs(parseLaunchArgs(settings.extraLaunchArgs), preservedArgs);

  workflowState = {
    ...workflowState,
    phase: 'quitting_app',
    message: `正在优雅退出当前 Antigravity，准备以「${target.nickname}」隔离环境重启...`,
  };
  broadcastState();

  await quitAppGracefully(settings.antigravityAppPath, { onAudit: recordAudit });

  workflowState = {
    ...workflowState,
    phase: 'launching_app',
    message: `正在注入隔离环境变量（HOME=${envPreview.HOME}）${launchArgs.length > 0 ? ` 与启动参数（${launchArgs.join(' ')}）` : ''} 并重启 Antigravity...`,
  };
  broadcastState();

  const launchedAtMs = Date.now();
  await launchAppWithEnv(settings.antigravityAppPath, envPreview, {
    launchArgs,
    onAudit: recordAudit,
  });

  store.setActiveAccount(target.id);
  appStatus = await getAntigravityAppStatus(settings.antigravityAppPath);

  const hasCdpFlag = hasRemoteDebuggingPortFlag(launchArgs);
  const effectiveCommands = getEffectivePostRestartCommands(settings);

  if (hasCdpFlag || effectiveCommands.some((c) => c.enabled && c.command.trim())) {
    workflowState = {
      ...workflowState,
      message: 'Antigravity 已重启，正在等待工作台 CDP 页面就绪并自动挂载扩展插件...',
    };
    broadcastState();
    return await runPostRestartCommands(effectiveCommands, {
      waitForPort: extractRemoteDebuggingPort(launchArgs),
      hasCdpFlag,
      profileHome: envPreview.HOME,
      launchedAtMs,
      onAudit: recordAudit,
    });
  }

  return { total: 0, succeeded: 0, failed: [] };
}

async function startLoginFlow(input: LoginStartInput): Promise<void> {
  if (isWorkflowRunning()) {
    throw new Error('当前有操作正在进行中，请稍候或取消后再试');
  }

  const target = store.getAccount(input.accountId);
  if (!target) {
    throw new Error('目标账号槽位不存在');
  }

  const settings = store.getSettings();
  const agyPath = resolveAgyBinary(settings.agyPathOverride);
  if (!agyPath) {
    workflowState = {
      kind: 'login',
      phase: 'error',
      targetAccountId: target.id,
      authMode: input.authMode,
      message: 'ACP 登录失败',
      error: '未找到官方 agy CLI 可执行文件',
    };
    broadcastState();
    return;
  }

  const abortController = new AbortController();
  activeWorkflowAbort = abortController;

  try {
    workflowState = {
      kind: 'login',
      phase: 'preparing_env',
      targetAccountId: target.id,
      authMode: input.authMode,
      restartAfterLogin: input.restartAfterLogin,
      message: `正在准备「${target.nickname}」的隔离环境变量与独立钥匙串...`,
    };
    broadcastState();

    const built = await ensureIsolatedProfileReady(target, {
      profilesRootDir: settings.profilesRootDir,
      shareConversationsAndProjects: settings.shareConversationsAndProjects,
      shareGlobalCustomizations: settings.shareGlobalCustomizations,
      symlinkShellConfig: settings.symlinkShellConfig,
      onAudit: recordAudit,
    });

    if (abortController.signal.aborted) {
      throw new Error('Cancelled by user');
    }

    await executeAcpLoginInProfile(target, input.authMode, agyPath, built.env, abortController.signal);

    if (abortController.signal.aborted) {
      throw new Error('Cancelled by user');
    }

    workflowState = {
      ...workflowState,
      phase: 'probing',
      message: `正在通过 agy acp 校验「${target.nickname}」的隔离会话状态...`,
    };
    broadcastState();

    const status = await probeAccountInternal(target, agyPath, settings);
    if (!status.authenticated) {
      throw new Error('ACP 校验显示该槽位仍未登录，请重试授权');
    }

    const latestTarget = store.getAccount(target.id) ?? target;

    let hooksResult: PostRestartHooksResult | undefined;
    if (input.restartAfterLogin) {
      hooksResult = await restartAntigravityForAccount(latestTarget, settings, built.envPreview);
    }

    const hookWarning = formatHookWarningSuffix(hooksResult);
    workflowState = {
      kind: 'login',
      phase: 'done',
      targetAccountId: latestTarget.id,
      authMode: input.authMode,
      restartAfterLogin: input.restartAfterLogin,
      message: input.restartAfterLogin
        ? `「${latestTarget.nickname}」${latestTarget.emailHint ? ` (${latestTarget.emailHint})` : ''} 已完成 ACP 登录，并以隔离环境重启 Antigravity（后续切换免重登）${hookWarning}`
        : `「${latestTarget.nickname}」${latestTarget.emailHint ? ` (${latestTarget.emailHint})` : ''} 已完成 ACP 登录并缓存于独立环境，随时可一键免重登切换`,
    };
    broadcastState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted || /cancelled by user/i.test(msg)) {
      workflowState = {
        kind: 'login',
        phase: 'cancelled',
        targetAccountId: target.id,
        authMode: input.authMode,
        message: '已取消 ACP 登录流程',
      };
    } else {
      workflowState = {
        kind: 'login',
        phase: 'error',
        targetAccountId: target.id,
        authMode: input.authMode,
        message: 'ACP 登录过程中出现错误',
        error: msg,
      };
    }
    broadcastState();
  } finally {
    activeWorkflowAbort = null;
    activeTerminalSession = null;
  }
}

async function startQuickAddAccount(options?: { restartAfterLogin?: boolean }): Promise<void> {
  if (isWorkflowRunning()) {
    throw new Error('当前有操作正在进行中，请稍候或取消后再试');
  }

  const settings = store.getSettings();
  const agyPath = resolveAgyBinary(settings.agyPathOverride);
  if (!agyPath) {
    workflowState = {
      kind: 'quick_add',
      phase: 'error',
      authMode: 'oauth-personal',
      autoCreatedAccount: true,
      message: '一键添加账号失败',
      error: '未找到官方 agy CLI 可执行文件，请在设置中检查路径。',
    };
    broadcastState();
    return;
  }

  const defaults = generateNextAccountDefaults(store.listAccounts());
  const created = store.upsertAccount({
    nickname: defaults.nickname,
    color: defaults.color,
    isolationMode: 'isolated',
    preferredAuthMode: 'oauth-personal',
  });

  const previewBuilt = buildProfileEnv(created, { profilesRootDir: settings.profilesRootDir });
  sessionStatuses[created.id] = {
    accountId: created.id,
    authenticated: false,
    supportsLogout: true,
    checkedAt: new Date().toISOString(),
    profileHome: previewBuilt.profileHome,
    envPreview: previewBuilt.envPreview,
  };

  const abortController = new AbortController();
  activeWorkflowAbort = abortController;

  try {
    workflowState = {
      kind: 'quick_add',
      phase: 'preparing_env',
      targetAccountId: created.id,
      authMode: 'oauth-personal',
      restartAfterLogin: Boolean(options?.restartAfterLogin),
      autoCreatedAccount: true,
      message: `已自动创建隔离槽位「${created.nickname}」，正在初始化独立环境并拉起浏览器...`,
    };
    broadcastState();

    const built = await ensureIsolatedProfileReady(created, {
      profilesRootDir: settings.profilesRootDir,
      shareConversationsAndProjects: settings.shareConversationsAndProjects,
      shareGlobalCustomizations: settings.shareGlobalCustomizations,
      symlinkShellConfig: settings.symlinkShellConfig,
      onAudit: recordAudit,
    });

    if (abortController.signal.aborted) {
      throw new Error('Cancelled by user');
    }

    await executeAcpLoginInProfile(
      created,
      'oauth-personal',
      agyPath,
      built.env,
      abortController.signal,
    );

    if (abortController.signal.aborted) {
      throw new Error('Cancelled by user');
    }

    workflowState = {
      ...workflowState,
      phase: 'probing',
      message: `正在通过 agy acp 校验「${created.nickname}」的隔离会话状态...`,
    };
    broadcastState();

    const status = await probeAccountInternal(created, agyPath, settings);
    if (!status.authenticated) {
      throw new Error('ACP 校验显示该槽位仍未登录，请重试授权');
    }

    const latestCreated = store.getAccount(created.id) ?? created;

    let hooksResult: PostRestartHooksResult | undefined;
    if (options?.restartAfterLogin) {
      hooksResult = await restartAntigravityForAccount(latestCreated, settings, built.envPreview);
    }

    const hookWarning = formatHookWarningSuffix(hooksResult);
    workflowState = {
      kind: 'quick_add',
      phase: 'done',
      targetAccountId: latestCreated.id,
      authMode: 'oauth-personal',
      restartAfterLogin: Boolean(options?.restartAfterLogin),
      autoCreatedAccount: true,
      message: options?.restartAfterLogin
        ? `「${latestCreated.nickname}」${latestCreated.emailHint ? ` (${latestCreated.emailHint})` : ''} 已完成 ACP 登录并重启 Antigravity（后续切换免重登）${hookWarning}`
        : latestCreated.emailHint
          ? `已自动识别邮箱 ${latestCreated.emailHint} 并保存至「${latestCreated.nickname}」独立隔离环境`
          : `「${latestCreated.nickname}」已完成浏览器 ACP 登录并保存至独立隔离环境`,
    };
    broadcastState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isAuthenticated = sessionStatuses[created.id]?.authenticated === true;
    if (!isAuthenticated) {
      try {
        store.deleteAccount(created.id);
      } catch {
        // ignore rollback error
      }
      delete sessionStatuses[created.id];
      try {
        removeIsolatedProfileDir(created, settings.profilesRootDir);
      } catch {
        // ignore cleanup error
      }
    }

    if (abortController.signal.aborted || /cancelled by user/i.test(msg)) {
      workflowState = {
        kind: 'quick_add',
        phase: 'cancelled',
        authMode: 'oauth-personal',
        autoCreatedAccount: true,
        message: '已取消本次一键添加账号',
      };
    } else {
      workflowState = {
        kind: 'quick_add',
        phase: 'error',
        authMode: 'oauth-personal',
        autoCreatedAccount: true,
        message: '一键添加账号未完成',
        error: msg,
      };
    }
    broadcastState();
  } finally {
    activeWorkflowAbort = null;
    activeTerminalSession = null;
  }
}

async function startSwitchAndRestart(input: SwitchStartInput): Promise<void> {
  if (isWorkflowRunning()) {
    throw new Error('当前有操作正在进行中，请稍候或取消后再试');
  }

  const target = store.getAccount(input.accountId);
  if (!target) {
    throw new Error('目标账号槽位不存在');
  }

  const settings = store.getSettings();
  const agyPath = resolveAgyBinary(settings.agyPathOverride);
  if (!agyPath) {
    workflowState = {
      kind: 'switch',
      phase: 'error',
      targetAccountId: target.id,
      message: '切换失败',
      error: '未找到官方 agy CLI 可执行文件',
    };
    broadcastState();
    return;
  }

  const authMode = input.authModeOverride ?? target.preferredAuthMode;
  const abortController = new AbortController();
  activeWorkflowAbort = abortController;

  try {
    workflowState = {
      kind: 'switch',
      phase: 'preparing_env',
      targetAccountId: target.id,
      authMode,
      restartAfterLogin: true,
      message: `正在准备「${target.nickname}」的隔离环境变量...`,
    };
    broadcastState();

    const built = await ensureIsolatedProfileReady(target, {
      profilesRootDir: settings.profilesRootDir,
      shareConversationsAndProjects: settings.shareConversationsAndProjects,
      shareGlobalCustomizations: settings.shareGlobalCustomizations,
      symlinkShellConfig: settings.symlinkShellConfig,
      onAudit: recordAudit,
    });

    workflowState = {
      ...workflowState,
      phase: 'probing',
      message: `正在检查「${target.nickname}」是否已存在可复用的 ACP 会话...`,
    };
    broadcastState();

    let status = await probeAccountInternal(target, agyPath, settings);

    if (!status.authenticated) {
      // First time for this slot (or expired session): authenticate via `agy acp`, then restart app.
      await executeAcpLoginInProfile(target, authMode, agyPath, built.env, abortController.signal);
      if (abortController.signal.aborted) {
        throw new Error('Cancelled by user');
      }
      workflowState = {
        ...workflowState,
        phase: 'probing',
        message: `正在校验「${target.nickname}」的全新 ACP 会话...`,
      };
      broadcastState();
      status = await probeAccountInternal(target, agyPath, settings);
      if (!status.authenticated) {
        throw new Error('ACP 登录完成但会话校验仍未通过，请重试');
      }
    }

    if (abortController.signal.aborted) {
      throw new Error('Cancelled by user');
    }

    const latestTarget = store.getAccount(target.id) ?? target;

    const hooksResult = await restartAntigravityForAccount(latestTarget, settings, built.envPreview);
    const hookWarning = formatHookWarningSuffix(hooksResult);

    workflowState = {
      kind: 'switch',
      phase: 'done',
      targetAccountId: latestTarget.id,
      authMode,
      message: `已成功切换到「${latestTarget.nickname}」${latestTarget.emailHint ? ` (${latestTarget.emailHint})` : ''} 并重启 Antigravity${hookWarning}`,
    };
    broadcastState();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (abortController.signal.aborted || /cancelled by user/i.test(msg)) {
      workflowState = {
        kind: 'switch',
        phase: 'cancelled',
        targetAccountId: target.id,
        message: '已取消账号切换',
      };
    } else {
      workflowState = {
        kind: 'switch',
        phase: 'error',
        targetAccountId: target.id,
        message: '切换并重启 Antigravity 失败',
        error: msg,
      };
    }
    broadcastState();
  } finally {
    activeWorkflowAbort = null;
    activeTerminalSession = null;
  }
}

async function restartActiveApp(): Promise<void> {
  if (isWorkflowRunning()) {
    throw new Error('当前有操作正在进行中');
  }
  const activeId = store.getActiveAccountId();
  if (!activeId) {
    throw new Error('请先选择或切换到一个账号槽位');
  }
  await startSwitchAndRestart({ accountId: activeId });
}

async function logoutAccount(accountId: string): Promise<AppStateSnapshot> {
  const target = store.getAccount(accountId);
  if (!target) {
    throw new Error('目标账号槽位不存在');
  }
  const settings = store.getSettings();
  const agyPath = resolveAgyBinary(settings.agyPathOverride);
  if (!agyPath) {
    throw new Error('未找到官方 agy CLI 可执行文件');
  }

  const built = buildProfileEnv(target, { profilesRootDir: settings.profilesRootDir });
  const client = new AcpClient({ agyPath, env: built.env, onAudit: recordAudit });
  try {
    await client.initialize();
    const probe = await client.probeAuthStatus(getProbeCwd());
    if (probe.authenticated) {
      await client.logout();
    }
  } finally {
    await client.close();
  }

  return await probeSingleAccount(accountId);
}

function applyThemeSetting(theme: AppSettings['theme']): void {
  nativeTheme.themeSource = theme;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
  }
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
}

function createMainWindow(): void {
  const isSmokeTest = process.env.ACP_MANAGER_SMOKE_TEST === '1';

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 880,
    minHeight: 620,
    show: !isSmokeTest,
    title: 'Antigravity Account Manager',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0b0f19',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('PRELOAD_ERROR', preloadPath, error);
    if (isSmokeTest) app.exit(1);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('RENDER_GONE', details);
    if (isSmokeTest) app.exit(1);
  });

  if (isSmokeTest) {
    const smokeTimeout = setTimeout(() => {
      console.error('ELECTRON_SMOKE_TIMEOUT');
      app.exit(1);
    }, 10000);

    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          clearTimeout(smokeTimeout);
          app.exit(1);
          return;
        }
        mainWindow.webContents
          .executeJavaScript(
            `(() => ({
              hasBridge: typeof window.accountManager === 'object' && window.accountManager !== null,
              rootLen: document.getElementById('root')?.innerHTML.length ?? 0,
              title: document.body.innerText.slice(0, 80),
            }))()`,
          )
          .then((result: { hasBridge: boolean; rootLen: number; title: string }) => {
            clearTimeout(smokeTimeout);
            if (result.hasBridge && result.rootLen > 50) {
              console.log('ELECTRON_SMOKE_OK', JSON.stringify(result));
              app.exit(0);
            } else {
              console.error('ELECTRON_SMOKE_FAIL', JSON.stringify(result));
              app.exit(1);
            }
          })
          .catch((err: unknown) => {
            clearTimeout(smokeTimeout);
            console.error('ELECTRON_SMOKE_EXEC_ERROR', err);
            app.exit(1);
          });
      }, 800);
    });
  }

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('state:get', () => getSnapshotState());

  ipcMain.handle('acp:refreshAll', async () => await refreshAll());

  ipcMain.handle('acp:probeAccount', async (_evt, accountId: string) => {
    return await probeSingleAccount(accountId);
  });

  ipcMain.handle('account:save', async (_evt, input: AccountSaveInput) => {
    const isEditingExisting = Boolean(input.id && sessionStatuses[input.id]);
    const saved = store.upsertAccount(input);
    const settings = store.getSettings();
    const built =
      saved.isolationMode === 'isolated'
        ? await ensureIsolatedProfileReady(saved, {
            profilesRootDir: settings.profilesRootDir,
            shareConversationsAndProjects: settings.shareConversationsAndProjects,
            shareGlobalCustomizations: settings.shareGlobalCustomizations,
            symlinkShellConfig: settings.symlinkShellConfig,
            onAudit: recordAudit,
          })
        : buildProfileEnv(saved, { profilesRootDir: settings.profilesRootDir });

    if (!sessionStatuses[saved.id]) {
      sessionStatuses[saved.id] = {
        accountId: saved.id,
        authenticated: false,
        supportsLogout: true,
        checkedAt: new Date().toISOString(),
        profileHome: built.profileHome,
        envPreview: built.envPreview,
      };
    } else {
      sessionStatuses[saved.id] = {
        ...sessionStatuses[saved.id],
        profileHome: built.profileHome,
        envPreview: built.envPreview,
      };
    }

    if (!isEditingExisting) {
      const agyPath = resolveAgyBinary(settings.agyPathOverride);
      if (agyPath) {
        await probeAccountInternal(saved, agyPath, settings);
      }
    }
    broadcastState();
    return {
      ...getSnapshotState(),
      savedAccountId: saved.id,
    };
  });

  ipcMain.handle('account:quickAdd', async (_evt, options?: { restartAfterLogin?: boolean }) => {
    void startQuickAddAccount(options);
  });

  ipcMain.handle('account:delete', (_evt, id: string, removeProfileDir?: boolean) => {
    const target = store.getAccount(id);
    const settings = store.getSettings();
    store.deleteAccount(id);
    delete sessionStatuses[id];
    if (target && removeProfileDir && target.isolationMode === 'isolated') {
      removeIsolatedProfileDir(target, settings.profilesRootDir);
    }
    broadcastState();
    return getSnapshotState();
  });

  ipcMain.handle('acp:loginStart', async (_evt, input: LoginStartInput) => {
    void startLoginFlow(input);
  });

  ipcMain.handle('app:switchAndRestart', async (_evt, input: SwitchStartInput) => {
    void startSwitchAndRestart(input);
  });

  ipcMain.handle('app:restartActive', async () => {
    void restartActiveApp();
  });

  ipcMain.handle('app:runPostRestartHooks', async () => {
    const settings = store.getSettings();
    const activeAccount = settings ? store.getAccount(store.getActiveAccountId() ?? '') : undefined;
    const profileHome = activeAccount
      ? getProfileHomeDir(activeAccount, settings.profilesRootDir)
      : undefined;

    let preservedArgs: string[] = [];
    try {
      const runningProcs = await findAppProcessPids(settings.antigravityAppPath);
      preservedArgs = extractPreservedLaunchArgs(runningProcs);
    } catch {
      preservedArgs = [];
    }
    const launchArgs = mergeLaunchArgs(parseLaunchArgs(settings.extraLaunchArgs), preservedArgs);
    const result = await runPostRestartCommands(getEffectivePostRestartCommands(settings), {
      waitForPort: extractRemoteDebuggingPort(launchArgs),
      hasCdpFlag: hasRemoteDebuggingPortFlag(launchArgs),
      profileHome,
      onAudit: recordAudit,
    });
    broadcastState();
    return {
      snapshot: getSnapshotState(),
      result,
    };
  });

  ipcMain.handle('acp:submitCode', async (_evt, code: string) => {
    if (!activeTerminalSession) {
      throw new Error('当前没有等待授权码的终端登录会话');
    }
    activeTerminalSession.submitCode(code);
  });

  ipcMain.handle('workflow:cancel', async () => {
    activeWorkflowAbort?.abort();
    activeTerminalSession?.cancel();
    if (
      workflowState.phase === 'done' ||
      workflowState.phase === 'error' ||
      workflowState.phase === 'cancelled'
    ) {
      workflowState = { kind: 'idle', phase: 'idle', message: '' };
      broadcastState();
    }
  });

  ipcMain.handle('acp:logoutAccount', async (_evt, accountId: string) => {
    return await logoutAccount(accountId);
  });

  ipcMain.handle('settings:update', async (_evt, partial: Partial<AppSettings>) => {
    const updated = store.updateSettings(partial);
    applyThemeSetting(updated.theme);
    if (
      partial.shareConversationsAndProjects !== undefined ||
      partial.shareGlobalCustomizations !== undefined ||
      partial.symlinkShellConfig !== undefined
    ) {
      for (const acc of store.listAccounts()) {
        if (acc.isolationMode === 'isolated') {
          await ensureIsolatedProfileReady(acc, {
            profilesRootDir: updated.profilesRootDir,
            shareConversationsAndProjects: updated.shareConversationsAndProjects,
            shareGlobalCustomizations: updated.shareGlobalCustomizations,
            symlinkShellConfig: updated.symlinkShellConfig,
            onAudit: recordAudit,
          });
        }
      }
    }
    broadcastState();
    return getSnapshotState();
  });

  ipcMain.handle('shell:openProfileFolder', async (_evt, accountId?: string) => {
    const settings = store.getSettings();
    let targetDir = settings.profilesRootDir;
    if (accountId) {
      const account = store.getAccount(accountId);
      if (account) {
        targetDir = getProfileHomeDir(account, settings.profilesRootDir);
      }
    }
    fs.mkdirSync(targetDir, { recursive: true });
    await shell.openPath(targetDir);
  });

  ipcMain.handle('audit:clear', () => {
    auditLog = [];
    broadcastState();
    return getSnapshotState();
  });

  ipcMain.handle('shell:openExternal', async (_evt, rawUrl: string) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error('无效的 URL');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('安全限制：仅允许打开 HTTPS 链接');
    }
    await shell.openExternal(parsed.toString());
  });

  ipcMain.handle('clipboard:writeText', (_evt, text: string) => {
    clipboard.writeText(text);
  });
}

app.whenReady().then(() => {
  const userDataDir = app.getPath('userData');
  const storePath = path.join(userDataDir, 'profiles.json');
  if (process.env.ACP_MANAGER_SMOKE_TEST !== '1' && !fs.existsSync(storePath)) {
    const legacyStorePath = path.join(
      app.getPath('appData'),
      'antigravity-account-manager',
      'profiles.json',
    );
    if (legacyStorePath !== storePath && fs.existsSync(legacyStorePath)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      fs.copyFileSync(legacyStorePath, storePath);
    }
  }
  store = new ProfileStore(storePath);
  applyThemeSetting(store.getSettings().theme);

  registerIpcHandlers();

  if (process.env.ACP_MANAGER_SMOKE_TEST !== '1') {
    tray = new Tray(createTrayTemplateIcon());
    tray.setToolTip('Antigravity Account Manager');
    updateTray();
  }

  createMainWindow();

  if (process.env.ACP_MANAGER_SMOKE_TEST !== '1') {
    void refreshAll();
  }

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep macOS Menu Bar Tray active when window closes
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
