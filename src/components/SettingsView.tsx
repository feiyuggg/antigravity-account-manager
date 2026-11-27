import { ArrowUpCircle, ExternalLink, FolderOpen, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type {
  AppSettings,
  AuthMode,
  PostRestartCommandItem,
  PostRestartHooksResult,
  RuntimeInfo,
  UpdateState,
} from '../../shared/types';

interface SettingsViewProps {
  settings: AppSettings;
  runtimeInfo: RuntimeInfo | null;
  updateState: UpdateState;
  onUpdateSettings: (partial: Partial<AppSettings>) => Promise<void>;
  onRunPostRestartHooks: () => Promise<PostRestartHooksResult>;
  onCheckForUpdates: () => void;
  onOpenExternalUrl: (url: string) => void;
  onOpenProfilesFolder: () => void;
}

export function SettingsView({
  settings,
  runtimeInfo,
  updateState,
  onUpdateSettings,
  onRunPostRestartHooks,
  onCheckForUpdates,
  onOpenExternalUrl,
  onOpenProfilesFolder,
}: SettingsViewProps) {
  const [agyInput, setAgyInput] = useState(settings.agyPathOverride);
  const [appPathInput, setAppPathInput] = useState(settings.antigravityAppPath);
  const [profilesDirInput, setProfilesDirInput] = useState(settings.profilesRootDir);
  const [extraArgsInput, setExtraArgsInput] = useState(settings.extraLaunchArgs);
  const [postCommands, setPostCommands] = useState<PostRestartCommandItem[]>(() =>
    settings.postRestartCommands?.length
      ? settings.postRestartCommands
      : settings.postRestartCommand.trim()
        ? [
            {
              id: window.crypto.randomUUID(),
              name: '重启后命令',
              command: settings.postRestartCommand.trim(),
              enabled: true,
            },
          ]
        : [],
  );
  const [savedNotice, setSavedNotice] = useState(false);
  const [hooksRunning, setHooksRunning] = useState(false);
  const [hooksNotice, setHooksNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const handleAddCommand = () => {
    setPostCommands((prev) => [
      ...prev,
      {
        id: window.crypto.randomUUID(),
        name: '',
        command: '',
        enabled: true,
      },
    ]);
  };

  const handleUpdateCommand = (id: string, patch: Partial<PostRestartCommandItem>) => {
    setPostCommands((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  };

  const handleRemoveCommand = (id: string) => {
    setPostCommands((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSavePaths = async () => {
    const cleanedCommands = postCommands
      .map((item) => ({
        ...item,
        name: item.name.trim(),
        command: item.command.trim(),
      }))
      .filter((item) => item.name.length > 0 || item.command.length > 0);
    setPostCommands(cleanedCommands);

    await onUpdateSettings({
      agyPathOverride: agyInput.trim(),
      antigravityAppPath: appPathInput.trim() || '/Applications/Antigravity.app',
      profilesRootDir: profilesDirInput.trim() || settings.profilesRootDir,
      extraLaunchArgs: extraArgsInput.trim(),
      postRestartCommand: '',
      postRestartCommands: cleanedCommands,
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 1800);
  };

  const handleRunHooksNow = async () => {
    setHooksRunning(true);
    setHooksNotice(null);
    try {
      await handleSavePaths();
      const res = await onRunPostRestartHooks();
      if (res.total === 0) {
        setHooksNotice({ ok: false, text: '没有已启用的重启后命令' });
      } else if (res.failed.length === 0) {
        setHooksNotice({ ok: true, text: `已成功执行 ${res.succeeded}/${res.total} 个插件命令` });
      } else {
        const failedNames = res.failed.map((f) => f.name).join('、');
        setHooksNotice({
          ok: false,
          text: `${res.succeeded}/${res.total} 成功；失败：${failedNames}（请查看「ACP 审计日志」）`,
        });
      }
    } catch (err) {
      setHooksNotice({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setHooksRunning(false);
    }
  };

  return (
    <div className="container">
      <div className="section-header">
        <div>
          <h2 className="section-title">环境变量隔离与合规设置</h2>
          <div className="section-subtitle">
            仅通过官方 `agy acp` 认证与独立环境目录实现免重登切换，不调用额度接口，不读取任何令牌或 Keychain。
          </div>
        </div>
      </div>

      <div className="settings-list">
        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">官方 `agy` CLI 路径</div>
            <div className="setting-desc">
              当前解析：<span className="mono">{runtimeInfo?.agyPath ?? '未找到'}</span>
              {runtimeInfo?.agyVersion ? `（${runtimeInfo.agyVersion}）` : ''}。留空将自动探测。
            </div>
          </div>
          <div style={{ minWidth: '300px' }}>
            <input
              className="input mono"
              placeholder="留空自动探测，或填写绝对路径"
              value={agyInput}
              onChange={(e) => setAgyInput(e.target.value)}
            />
          </div>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">Antigravity.app 安装路径</div>
            <div className="setting-desc">
              切换账号后将优雅退出该应用，并通过 macOS <code>open -n -a ... --env</code> 注入隔离环境变量重启。
            </div>
          </div>
          <div style={{ minWidth: '300px' }}>
            <input
              className="input mono"
              value={appPathInput}
              onChange={(e) => setAppPathInput(e.target.value)}
            />
          </div>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">独立环境槽位根目录</div>
            <div className="setting-desc">
              每个隔离槽位的 <code>HOME</code>、<code>CFFIXED_USER_HOME</code> 与独立 Keychain 均存放在此目录内。
            </div>
          </div>
          <div className="action-group" style={{ minWidth: '340px' }}>
            <input
              className="input mono"
              value={profilesDirInput}
              onChange={(e) => setProfilesDirInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-sm" onClick={onOpenProfilesFolder}>
              <FolderOpen size={13} />
              打开
            </button>
          </div>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">Antigravity 附加启动参数（支持多个参数，用空格分隔）</div>
            <div className="setting-desc">
              多个参数直接用空格分隔（如 <code>--remote-debugging-port=58321 --disable-gpu-sandbox</code>）。
              <strong>一个 --remote-debugging-port=58321 同时兼容 antigravity-context-viewer 与 obsidian-prism</strong>
              ，切号重启时还会自动同步 <code>DevToolsActivePort</code> 供宿主插件守护进程识别。
            </div>
          </div>
          <div className="action-group" style={{ minWidth: '360px', flex: '0 1 440px' }}>
            <input
              className="input mono"
              placeholder="例如：--remote-debugging-port=58321"
              value={extraArgsInput}
              onChange={(e) => setExtraArgsInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setExtraArgsInput('--remote-debugging-port=58321')}
            >
              填入 CDP 58321
            </button>
          </div>
        </div>

        <div className="card setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div className="setting-info">
              <div className="setting-title">重启后自动执行命令列表（支持挂载多个插件）</div>
              <div className="setting-desc">
                Antigravity 切换重启且端口同步就绪后，按顺序在宿主环境自动启动已勾选的命令（如{' '}
                <code>antigravity-context-viewer</code> 的 <code>live</code> 与{' '}
                <code>obsidian-prism</code> 的 <code>npm run inject</code>）。<strong>切勿带 --relaunch</strong>，否则插件会以默认环境重开客户端导致切回原账号。
              </div>
            </div>
            <div className="action-group">
              <button
                type="button"
                className="btn btn-sm"
                disabled={hooksRunning || !postCommands.some((c) => c.enabled && c.command.trim())}
                onClick={() => void handleRunHooksNow()}
                title="保存当前设置并立即对运行中的 Antigravity 窗口执行已启用命令"
              >
                <Play size={13} />
                {hooksRunning ? '执行中...' : '立即执行命令'}
              </button>
              <button type="button" className="btn btn-sm" onClick={handleAddCommand}>
                <Plus size={13} />
                添加命令
              </button>
            </div>
          </div>

          {hooksNotice && (
            <div
              style={{
                fontSize: '12px',
                padding: '6px 10px',
                borderRadius: '6px',
                background: hooksNotice.ok ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                color: hooksNotice.ok ? '#10b981' : '#ef4444',
                marginTop: '6px',
              }}
            >
              {hooksNotice.text}
            </div>
          )}

          {postCommands.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '6px 0' }}>
              暂无自动执行命令。点击右上角「添加命令」可为多个外部插件配置热挂载命令。
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
              {postCommands.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    flexWrap: 'wrap',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={item.enabled}
                    onChange={(e) => handleUpdateCommand(item.id, { enabled: e.target.checked })}
                    title="启用或暂停此命令"
                  />
                  <input
                    className="input"
                    style={{ width: '170px' }}
                    placeholder="名称（如 Context Viewer）"
                    value={item.name}
                    onChange={(e) => handleUpdateCommand(item.id, { name: e.target.value })}
                  />
                  <input
                    className="input mono"
                    style={{ flex: 1, minWidth: '240px' }}
                    placeholder="命令（切勿带 --relaunch）"
                    value={item.command}
                    onChange={(e) => handleUpdateCommand(item.id, { command: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn icon-btn btn-danger"
                    onClick={() => handleRemoveCommand(item.id)}
                    title="移除此命令"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void handleSavePaths()}
          >
            {savedNotice ? '路径与启动设置已保存' : '保存路径与启动设置'}
          </button>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">默认 ACP 登录方式</div>
            <div className="setting-desc">
              新建账号卡片时预选的 `agy acp` 认证方式。多 Google 账号推荐使用 `agy acp --login`。
            </div>
          </div>
          <select
            className="select"
            style={{ width: '260px' }}
            value={settings.defaultAuthMode}
            onChange={(e) =>
              void onUpdateSettings({ defaultAuthMode: e.target.value as AuthMode })
            }
          >
            <option value="terminal-login">agy acp --login（终端授权码）</option>
            <option value="oauth-personal">agy acp（默认浏览器个人 OAuth）</option>
            <option value="oauth-business">agy acp（企业 / Cloud OAuth）</option>
          </select>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">跨账号共享历史会话与项目列表（推荐）</div>
            <div className="setting-desc">
              将主目录的 <code>conversations</code>、<code>brain</code>（Artifacts）、
              <code>annotations</code>、<code>projects</code>、<code>scratch</code>{' '}
              软链接到各隔离槽位，切号重启后保留全部项目与历史对话无缝续聊（Keychain 登录凭证依然完全独立）。
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.shareConversationsAndProjects}
              onChange={(e) =>
                void onUpdateSettings({ shareConversationsAndProjects: e.target.checked })
              }
            />
            <span style={{ fontSize: '13px' }}>
              {settings.shareConversationsAndProjects ? '已开启' : '已关闭'}
            </span>
          </label>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">保持已选账号（手动重开 Antigravity 时自动恢复当前槽位）</div>
            <div className="setting-desc">
              当本工具在菜单栏运行时，如果你退出后又从程序坞或 Spotlight 手动打开 Antigravity（系统默认会回到原生环境），将自动切回当前激活的隔离槽位并带上启动参数与插件（关闭后仅提示状态不一致）。
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.autoRestoreActiveAccount}
              onChange={(e) =>
                void onUpdateSettings({ autoRestoreActiveAccount: e.target.checked })
              }
            />
            <span style={{ fontSize: '13px' }}>
              {settings.autoRestoreActiveAccount ? '已开启' : '已关闭'}
            </span>
          </label>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">共享全局 Skills / Plugins / Rules</div>
            <div className="setting-desc">
              将主目录 <code>~/.gemini/config/</code> 下的 <code>skills</code>、<code>plugins</code>、
              <code>rules</code> 软链接到隔离槽位中，确保切换账号后扩展能力保持一致（绝不共享登录态目录）。
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.shareGlobalCustomizations}
              onChange={(e) =>
                void onUpdateSettings({ shareGlobalCustomizations: e.target.checked })
              }
            />
            <span style={{ fontSize: '13px' }}>
              {settings.shareGlobalCustomizations ? '已开启' : '已关闭'}
            </span>
          </label>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">共享终端与 Git 基础配置</div>
            <div className="setting-desc">
              在隔离槽位中软链接 <code>.zshrc</code>、<code>.gitconfig</code>、<code>.ssh</code>、
              <code>.local</code> 等开发配置，防止隔离 <code>HOME</code> 后终端或 Git 丢失习惯设置。
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.symlinkShellConfig}
              onChange={(e) => void onUpdateSettings({ symlinkShellConfig: e.target.checked })}
            />
            <span style={{ fontSize: '13px' }}>
              {settings.symlinkShellConfig ? '已开启' : '已关闭'}
            </span>
          </label>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">macOS 状态栏显示槽位编号 (#1/#2)</div>
            <div className="setting-desc">
              默认仅显示简洁图标以减少遮挡；开启后在图标旁显示固定宽度槽位编号（如 #1、#2）。
            </div>
          </div>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={settings.showTrayAccount}
              onChange={(e) => void onUpdateSettings({ showTrayAccount: e.target.checked })}
            />
            <span style={{ fontSize: '13px' }}>
              {settings.showTrayAccount ? '已开启' : '已关闭'}
            </span>
          </label>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">外观主题</div>
            <div className="setting-desc">切换浅色 / 深色 / 跟随 macOS 系统外观。</div>
          </div>
          <select
            className="select"
            style={{ width: '160px' }}
            value={settings.theme}
            onChange={(e) =>
              void onUpdateSettings({ theme: e.target.value as AppSettings['theme'] })
            }
          >
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>

        <div className="card setting-row">
          <div className="setting-info">
            <div className="setting-title">应用版本与 GitHub 自动更新</div>
            <div className="setting-desc">
              当前版本 <span className="mono">v{updateState.currentVersion}</span>
              {updateState.message ? ` · ${updateState.message}` : '。检查 GitHub Releases 并在检测到新版本后自动下载校验、替换并重启。'}
            </div>
          </div>
          <div className="action-group">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={
                updateState.phase === 'checking' ||
                updateState.phase === 'downloading' ||
                updateState.phase === 'verifying' ||
                updateState.phase === 'installing'
              }
              onClick={onCheckForUpdates}
            >
              <ArrowUpCircle size={13} />
              检查并自动更新
            </button>
            {updateState.releaseUrl && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onOpenExternalUrl(updateState.releaseUrl!)}
              >
                <ExternalLink size={13} />
                查看 Releases
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
