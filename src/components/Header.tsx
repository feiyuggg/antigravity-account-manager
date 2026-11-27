import { ArrowUpCircle, Loader2, RefreshCw, ScrollText, Settings, ShieldCheck, Users } from 'lucide-react';
import type { AntigravityAppStatus, RuntimeInfo, UpdateState } from '../../shared/types';

export type ActiveTab = 'dashboard' | 'settings' | 'audit';

interface HeaderProps {
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  runtimeInfo: RuntimeInfo | null;
  appStatus: AntigravityAppStatus | null;
  updateState: UpdateState;
  isRefreshing: boolean;
  onRefresh: () => void;
  onCheckForUpdates: () => void;
}

export function Header({
  activeTab,
  onTabChange,
  runtimeInfo,
  appStatus,
  updateState,
  isRefreshing,
  onRefresh,
  onCheckForUpdates,
}: HeaderProps) {
  const isUpdating =
    updateState.phase === 'checking' ||
    updateState.phase === 'downloading' ||
    updateState.phase === 'verifying' ||
    updateState.phase === 'installing';

  const updateButtonLabel =
    updateState.phase === 'checking'
      ? '检查中'
      : updateState.phase === 'downloading'
        ? `下载 ${updateState.progressPercent ?? 0}%`
        : updateState.phase === 'verifying'
          ? '校验中'
          : updateState.phase === 'installing'
            ? '更新重启中'
            : '检查更新';
  const dotClass = !runtimeInfo
    ? 'warn'
    : runtimeInfo.error || !runtimeInfo.agyPath
      ? 'danger'
      : 'good';

  const statusText = !runtimeInfo
    ? '检测中...'
    : runtimeInfo.error
      ? 'agy 未就绪'
      : appStatus?.running
        ? 'Antigravity 运行中'
        : 'Antigravity 未运行';

  return (
    <header className="titlebar">
      <div className="titlebar-left">
        <div className="brand">
          <span>Antigravity Account Manager</span>
        </div>
        <span
          className="brand-badge"
          title="仅使用官方 agy acp 认证与独立环境变量隔离，绝不调用额度接口或读取令牌"
        >
          <ShieldCheck size={12} />
          纯 agy acp · 环境隔离
        </span>
      </div>

      <div className="titlebar-center no-drag">
        <div className="segmented" role="tablist">
          <button
            type="button"
            className={activeTab === 'dashboard' ? 'active' : ''}
            onClick={() => onTabChange('dashboard')}
          >
            <Users size={14} />
            账号切换
          </button>
          <button
            type="button"
            className={activeTab === 'settings' ? 'active' : ''}
            onClick={() => onTabChange('settings')}
          >
            <Settings size={14} />
            隔离与设置
          </button>
          <button
            type="button"
            className={activeTab === 'audit' ? 'active' : ''}
            onClick={() => onTabChange('audit')}
          >
            <ScrollText size={14} />
            ACP 审计日志
          </button>
        </div>
      </div>

      <div className="titlebar-right no-drag">
        <div className="status-pill" title={runtimeInfo?.agyPath ?? '未检测到 agy'}>
          <span className={`dot ${dotClass}`} />
          <span>{statusText}</span>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={isRefreshing}
          onClick={onRefresh}
          title="刷新各槽位的 agy acp 会话状态与 Antigravity 运行状态"
        >
          <RefreshCw size={13} className={isRefreshing ? 'spin' : ''} />
          {isRefreshing ? '检测中' : '刷新状态'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          disabled={isUpdating}
          onClick={onCheckForUpdates}
          title={`当前版本 v${updateState.currentVersion}，点击检查 GitHub 最新 Release 并自动更新`}
        >
          {isUpdating ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <ArrowUpCircle size={13} />
          )}
          {updateButtonLabel}
        </button>
      </div>
    </header>
  );
}
