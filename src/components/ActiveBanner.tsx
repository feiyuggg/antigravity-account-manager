import { AppWindow, CheckCircle2, FolderCog, RotateCw, ShieldCheck } from 'lucide-react';
import type {
  AccountProfile,
  AntigravityAppStatus,
  ProfileSessionStatus,
  RuntimeInfo,
} from '../../shared/types';

interface ActiveBannerProps {
  runtimeInfo: RuntimeInfo | null;
  appStatus: AntigravityAppStatus | null;
  activeAccount?: AccountProfile;
  runningAccount?: AccountProfile;
  activeSession?: ProfileSessionStatus;
  accountsCount: number;
  isBusy: boolean;
  onRestartActive: () => void;
  onSyncActiveToRunning: () => void;
  onQuickCreateSystemSlot: () => void;
}

function formatCompactHomePath(profileHome: string): string {
  const compactHome = profileHome.replace(/^\/Users\/[^/]+/, '~');
  return compactHome.replace(
    /\/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    '/$1…',
  );
}

export function ActiveBanner({
  runtimeInfo,
  appStatus,
  activeAccount,
  runningAccount,
  activeSession,
  accountsCount,
  isBusy,
  onRestartActive,
  onSyncActiveToRunning,
  onQuickCreateSystemSlot,
}: ActiveBannerProps) {
  if (runtimeInfo?.error && !runtimeInfo.agyPath) {
    return (
      <section className="notice-banner warn">
        <div>
          <strong>未检测到官方 agy CLI：</strong>
          {runtimeInfo.error}
        </div>
      </section>
    );
  }

  return (
    <section className="card hero-card">
      <div className="hero-top">
        <div className="hero-identity">
          <div
            className="avatar-dot"
            style={{ background: activeAccount?.color ?? '#3b82f6' }}
          >
            {activeAccount ? activeAccount.nickname.slice(0, 1).toUpperCase() : 'A'}
          </div>
          <div>
            <h2 className="hero-title">
              {activeAccount ? `当前激活槽位：${activeAccount.nickname}` : '尚未激活任何账号槽位'}
              {activeAccount && (
                <span className={`chip ${activeSession?.authenticated ? 'good' : 'warn'}`}>
                  <CheckCircle2 size={11} />
                  {activeSession?.authenticated ? 'ACP 会话已就绪（免重登）' : '待 ACP 登录'}
                </span>
              )}
              {appStatus && (
                <span className={`chip ${appStatus.running ? 'accent' : ''}`}>
                  <AppWindow size={11} />
                  {appStatus.running
                    ? `Antigravity 运行中 (${appStatus.pids.length} 进程)`
                    : appStatus.exists
                      ? 'Antigravity 未运行'
                      : '未找到 Antigravity.app'}
                </span>
              )}
            </h2>
            <div className="hero-sub">
              {activeAccount?.emailHint && activeAccount.emailHint !== activeAccount.nickname && (
                <span>{activeAccount.emailHint}</span>
              )}
              {activeSession?.profileHome && (
                <span
                  className="mono"
                  title={`当前槽位注入给 Antigravity 的 HOME 与 CFFIXED_USER_HOME：${activeSession.profileHome}`}
                >
                  <FolderCog size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                  HOME={formatCompactHomePath(activeSession.profileHome)}
                </span>
              )}
              {!activeAccount && (
                <span>
                  每个槽位拥有独立隔离的 HOME、CFFIXED_USER_HOME 与 Keychain。首次通过 `agy acp`
                  登录后，后续点击切换即可直接退出并重启 Antigravity，无需重新登录。
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="action-group">
          {!activeAccount && accountsCount === 0 && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isBusy}
              onClick={onQuickCreateSystemSlot}
            >
              <ShieldCheck size={13} />
              纳管当前系统登录为第 1 个槽位
            </button>
          )}
          {activeAccount && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={isBusy}
              onClick={onRestartActive}
              title="退出当前 Antigravity 并注入当前槽位的隔离环境变量重新启动"
            >
              <RotateCw size={13} />
              以此槽位重启 Antigravity
            </button>
          )}
        </div>
      </div>

      {appStatus?.running &&
        activeAccount &&
        appStatus.runningProfileHome &&
        appStatus.runningAccountId !== activeAccount.id && (
          <div className="notice-banner warn" style={{ marginTop: '12px' }}>
            <div>
              <strong>运行环境与已选槽位不一致：</strong>
              Antigravity 当前实际以「
              {runningAccount
                ? runningAccount.nickname
                : `未纳管环境 (${formatCompactHomePath(appStatus.runningProfileHome)})`}
              」运行，并非「{activeAccount.nickname}」（可能是退出后直接从程序坞/Spotlight
              打开所致）。
            </div>
            <div className="action-group">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={isBusy}
                onClick={onRestartActive}
              >
                <RotateCw size={12} />
                切回「{activeAccount.nickname}」并重启
              </button>
              {runningAccount && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={isBusy}
                  onClick={onSyncActiveToRunning}
                >
                  同步面板为实际运行账号
                </button>
              )}
            </div>
          </div>
        )}
    </section>
  );
}
