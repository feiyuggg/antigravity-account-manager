import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit3,
  FolderOpen,
  KeyRound,
  LogOut,
  Power,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import type { AccountProfile, AuthMode, ProfileSessionStatus } from '../../shared/types';

interface AccountCardProps {
  account: AccountProfile;
  isActive: boolean;
  session?: ProfileSessionStatus;
  isBusy: boolean;
  onSwitchAndRestart: (account: AccountProfile) => void;
  onStartLogin: (account: AccountProfile, mode: AuthMode) => void;
  onProbe: (account: AccountProfile) => void;
  onLogout: (account: AccountProfile) => void;
  onOpenFolder: (account: AccountProfile) => void;
  onEdit: (account: AccountProfile) => void;
  onDelete: (account: AccountProfile) => void;
}

function formatDateTime(iso?: string): string {
  if (!iso) return '从未';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '从未';
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function AccountCard({
  account,
  isActive,
  session,
  isBusy,
  onSwitchAndRestart,
  onStartLogin,
  onProbe,
  onLogout,
  onOpenFolder,
  onEdit,
  onDelete,
}: AccountCardProps) {
  const [envOpen, setEnvOpen] = useState(false);

  const isAuthenticated = session?.authenticated === true;
  const authLabel = !session
    ? '待检测'
    : session.error
      ? '检测异常'
      : isAuthenticated
        ? '会话已就绪 · 免重登'
        : '待首次 ACP 登录';

  const authChipClass = !session
    ? ''
    : session.error
      ? 'warn'
      : isAuthenticated
        ? 'good'
        : 'warn';

  return (
    <article className={`card account-card ${isActive ? 'is-active' : ''}`}>
      <div className="account-card-head">
        <div className="account-card-left">
          <div className="avatar-sm" style={{ background: account.color }}>
            {account.nickname.slice(0, 1).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="account-name">{account.nickname}</div>
            <div className="account-email">
              {session?.detectedEmail ||
                account.emailHint ||
                (isAuthenticated ? '已认证会话' : '登录后自动获取邮箱')}
            </div>
          </div>
        </div>

        <div className="action-group">
          {isActive && (
            <span className="chip accent">
              <CheckCircle2 size={11} />
              当前激活
            </span>
          )}
          <span className={`chip ${authChipClass}`}>{authLabel}</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <span className="chip">
          <Shield size={11} />
          {account.isolationMode === 'isolated' ? '独立环境变量隔离' : '系统默认 HOME'}
        </span>
        <span className="chip">
          <Terminal size={11} />
          {account.preferredAuthMode === 'terminal-login'
            ? 'agy acp --login'
            : account.preferredAuthMode === 'oauth-business'
              ? 'ACP 企业 OAuth'
              : 'ACP 个人 OAuth'}
        </span>
      </div>

      {account.note && <div className="account-note">{account.note}</div>}

      {session?.error && (
        <div className="notice-banner warn" style={{ padding: '8px 10px', fontSize: '11.5px' }}>
          <span>{session.error}</span>
        </div>
      )}

      <div
        style={{
          fontSize: '11.5px',
          color: 'var(--text-muted)',
          display: 'flex',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <span>上次验证：{formatDateTime(account.lastVerifiedAt)}</span>
        <span>上次切换：{formatDateTime(account.lastSwitchedAt)}</span>
      </div>

      {session?.envPreview && (
        <div>
          <button
            type="button"
            className="btn btn-sm"
            style={{ width: '100%', justifyContent: 'space-between' }}
            onClick={() => setEnvOpen((v) => !v)}
          >
            <span>隔离环境变量 ({Object.keys(session.envPreview).length})</span>
            {envOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          {envOpen && (
            <div className="env-drawer" style={{ marginTop: '8px' }}>
              {Object.entries(session.envPreview).map(([k, v]) => (
                <div className="env-row" key={k}>
                  <span className="env-key mono">{k}</span>
                  <span className="env-val mono">{v}</span>
                </div>
              ))}
              <div style={{ marginTop: '4px' }}>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => onOpenFolder(account)}
                >
                  <FolderOpen size={12} />
                  在 Finder 中打开槽位目录
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="account-card-actions">
        <div className="action-group">
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={isBusy}
            onClick={() => onSwitchAndRestart(account)}
            title={
              isAuthenticated
                ? '退出当前 Antigravity，注入此槽位环境变量并直接重启（无需重登）'
                : '首次先通过 agy acp 登录此槽位，再自动重启 Antigravity'
            }
          >
            <Power size={12} />
            {isAuthenticated ? '切换并重启 Antigravity' : 'ACP 登录并启动'}
          </button>

          <button
            type="button"
            className="btn btn-sm"
            disabled={isBusy}
            onClick={() => onStartLogin(account, account.preferredAuthMode)}
            title="仅在隔离环境中执行 agy acp 登录（可先预热多个账号）"
          >
            <KeyRound size={12} />
            {isAuthenticated ? '重新授权' : '预登录'}
          </button>
        </div>

        <div className="action-group">
          <button
            type="button"
            className="btn icon-btn"
            disabled={isBusy}
            onClick={() => onProbe(account)}
            title="检测该槽位 agy acp 会话状态"
          >
            <RefreshCw size={13} />
          </button>
          {isAuthenticated && (
            <button
              type="button"
              className="btn icon-btn"
              disabled={isBusy || !session?.supportsLogout}
              onClick={() => onLogout(account)}
              title="仅登出此槽位的 ACP 会话（不影响其他槽位）"
            >
              <LogOut size={13} />
            </button>
          )}
          <button
            type="button"
            className="btn icon-btn"
            disabled={isBusy}
            onClick={() => onEdit(account)}
            title="编辑账号信息"
          >
            <Edit3 size={13} />
          </button>
          <button
            type="button"
            className="btn icon-btn btn-danger"
            disabled={isBusy}
            onClick={() => onDelete(account)}
            title="删除账号槽位"
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </article>
  );
}
