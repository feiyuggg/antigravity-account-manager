import { Globe, Plus, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  AccountProfile,
  AccountSaveInput,
  AppSettings,
  AppStateSnapshot,
  AuthMode,
  IsolationMode,
} from '../shared/types';
import { AccountCard } from './components/AccountCard';
import { AccountFormModal } from './components/AccountFormModal';
import { ActiveBanner } from './components/ActiveBanner';
import { AuditLogView } from './components/AuditLogView';
import { ActiveTab, Header } from './components/Header';
import { SettingsView } from './components/SettingsView';
import { WorkflowModal } from './components/WorkflowModal';

export default function App() {
  const [state, setState] = useState<AppStateSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<ActiveTab>('dashboard');
  const [formModal, setFormModal] = useState<{
    open: boolean;
    editing?: AccountProfile;
    defaultIsolationMode?: IsolationMode;
  }>({ open: false });

  useEffect(() => {
    let mounted = true;
    void window.accountManager.getState().then((initial) => {
      if (mounted) setState(initial);
    });
    const unsubscribe = window.accountManager.onStateChanged((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  if (!state) {
    return (
      <div className="app-shell" style={{ display: 'grid', placeItems: 'center' }}>
        <div style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
          正在初始化 Antigravity Account Manager...
        </div>
      </div>
    );
  }

  const activeAccount = state.accounts.find((a) => a.id === state.activeAccountId);
  const activeSession = activeAccount ? state.sessionStatuses[activeAccount.id] : undefined;
  const hasSystemSlot = state.accounts.some((a) => a.isolationMode === 'system');
  const isWorkflowBusy =
    state.workflowState.phase !== 'idle' &&
    state.workflowState.phase !== 'done' &&
    state.workflowState.phase !== 'error' &&
    state.workflowState.phase !== 'cancelled';
  const isBusy = isWorkflowBusy || state.isRefreshing;
  const targetAccount = state.accounts.find((a) => a.id === state.workflowState.targetAccountId);

  const handleSaveAccount = async (input: AccountSaveInput) => {
    const next = await window.accountManager.saveAccount(input);
    setState(next);
  };

  const handleDeleteAccount = async (account: AccountProfile) => {
    if (account.isolationMode === 'isolated') {
      const ok = window.confirm(
        `确定删除账号槽位「${account.nickname}」并清理其独立环境变量目录吗？`,
      );
      if (!ok) return;
      const next = await window.accountManager.deleteAccount(account.id, true);
      setState(next);
    } else {
      const ok = window.confirm(
        `确定移除系统默认环境槽位「${account.nickname}」吗？（不会影响你的真实主目录数据）`,
      );
      if (!ok) return;
      const next = await window.accountManager.deleteAccount(account.id, false);
      setState(next);
    }
  };

  const handleLogoutAccount = async (account: AccountProfile) => {
    const ok = window.confirm(
      `确定仅登出槽位「${account.nickname}」的 agy acp 会话吗？（不会影响其他隔离槽位）`,
    );
    if (!ok) return;
    const next = await window.accountManager.logoutAccount(account.id);
    setState(next);
  };

  const handleUpdateSettings = async (partial: Partial<AppSettings>) => {
    const next = await window.accountManager.updateSettings(partial);
    setState(next);
  };

  const handleQuickAddFinish = async (
    account: AccountProfile,
    updates: { nickname: string; emailHint: string },
    switchNow: boolean,
  ) => {
    const trimmedNickname = updates.nickname.trim() || account.nickname;
    const trimmedEmail = updates.emailHint.trim();
    if (trimmedNickname !== account.nickname || trimmedEmail !== (account.emailHint ?? '')) {
      await window.accountManager.saveAccount({
        id: account.id,
        nickname: trimmedNickname,
        emailHint: trimmedEmail,
        note: account.note,
        color: account.color,
        isolationMode: account.isolationMode,
        preferredAuthMode: account.preferredAuthMode,
      });
    }
    await window.accountManager.cancelWorkflow();
    if (switchNow) {
      await window.accountManager.startSwitchAndRestart({ accountId: account.id });
    }
  };

  return (
    <div className="app-shell">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        runtimeInfo={state.runtimeInfo}
        appStatus={state.appStatus}
        isRefreshing={state.isRefreshing}
        onRefresh={() => void window.accountManager.refreshAll().then(setState)}
      />

      <main className="main-content">
        {activeTab === 'dashboard' && (
          <div className="container">
            <ActiveBanner
              runtimeInfo={state.runtimeInfo}
              appStatus={state.appStatus}
              activeAccount={activeAccount}
              activeSession={activeSession}
              accountsCount={state.accounts.length}
              isBusy={isBusy}
              onRestartActive={() => void window.accountManager.restartActiveApp()}
              onQuickCreateSystemSlot={() =>
                setFormModal({ open: true, defaultIsolationMode: 'system' })
              }
            />

            <div className="section-header">
              <div>
                <h2 className="section-title">环境变量隔离账号槽位 ({state.accounts.length})</h2>
                <div className="section-subtitle">
                  点击「一键添加账号」直接跳转浏览器完成 <code>agy acp</code> 登录；切换账号时退出并重启
                  Antigravity，默认保留全部共享的历史会话与项目，无需重新登录。
                </div>
              </div>
              <div className="action-group">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={isBusy}
                  onClick={() =>
                    void window.accountManager.quickAddAccount({ restartAfterLogin: false })
                  }
                >
                  <Globe size={14} />
                  一键添加账号（浏览器认证）
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={isBusy}
                  onClick={() => setFormModal({ open: true, defaultIsolationMode: 'isolated' })}
                >
                  <Plus size={14} />
                  自定义槽位...
                </button>
              </div>
            </div>

            {state.accounts.length === 0 ? (
              <section className="card" style={{ padding: '28px', textAlign: 'center' }}>
                <ShieldCheck size={30} style={{ color: 'var(--accent)', marginBottom: '10px' }} />
                <div style={{ fontSize: '15px', fontWeight: 650, marginBottom: '6px' }}>
                  开始配置你的多账号免重登环境
                </div>
                <div
                  style={{
                    fontSize: '12.5px',
                    color: 'var(--text-muted)',
                    maxWidth: '560px',
                    margin: '0 auto 18px',
                    lineHeight: 1.6,
                  }}
                >
                  点击下方「一键添加账号」即可自动创建独立隔离的 <code>HOME</code> 与{' '}
                  <code>CFFIXED_USER_HOME</code> 并直接拉起浏览器完成 <code>agy acp</code> 认证；
                  也可将当前系统已登录环境纳管为第 1 个槽位。
                </div>
                <div className="action-group" style={{ justifyContent: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={isBusy}
                    onClick={() =>
                      void window.accountManager.quickAddAccount({ restartAfterLogin: false })
                    }
                  >
                    <Globe size={14} />
                    一键添加账号（直接跳转浏览器认证）
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={isBusy}
                    onClick={() => setFormModal({ open: true, defaultIsolationMode: 'system' })}
                  >
                    纳管系统默认环境为槽位 1
                  </button>
                </div>
              </section>
            ) : (
              <div className="accounts-grid">
                {state.accounts.map((account) => (
                  <AccountCard
                    key={account.id}
                    account={account}
                    isActive={account.id === state.activeAccountId}
                    session={state.sessionStatuses[account.id]}
                    isBusy={isBusy}
                    onSwitchAndRestart={(acc) =>
                      void window.accountManager.startSwitchAndRestart({ accountId: acc.id })
                    }
                    onStartLogin={(acc, mode: AuthMode) =>
                      void window.accountManager.startLogin({
                        accountId: acc.id,
                        authMode: mode,
                        restartAfterLogin: false,
                      })
                    }
                    onProbe={(acc) =>
                      void window.accountManager.probeAccount(acc.id).then(setState)
                    }
                    onLogout={(acc) => void handleLogoutAccount(acc)}
                    onOpenFolder={(acc) =>
                      void window.accountManager.openProfileInFinder(acc.id)
                    }
                    onEdit={(acc) => setFormModal({ open: true, editing: acc })}
                    onDelete={(acc) => void handleDeleteAccount(acc)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <SettingsView
            settings={state.settings}
            runtimeInfo={state.runtimeInfo}
            onUpdateSettings={handleUpdateSettings}
            onOpenProfilesFolder={() => void window.accountManager.openProfileInFinder()}
          />
        )}

        {activeTab === 'audit' && (
          <AuditLogView
            entries={state.auditLog}
            onClear={() => void window.accountManager.clearAuditLog().then(setState)}
          />
        )}
      </main>

      {formModal.open && (
        <AccountFormModal
          initial={formModal.editing}
          defaultAuthMode={state.settings.defaultAuthMode}
          hasSystemSlot={hasSystemSlot}
          defaultIsolationMode={formModal.defaultIsolationMode}
          onClose={() => setFormModal({ open: false })}
          onSave={handleSaveAccount}
        />
      )}

      <WorkflowModal
        workflowState={state.workflowState}
        targetAccount={targetAccount}
        onSubmitCode={(code) => window.accountManager.submitAuthCode(code)}
        onCopyUrl={(url) => window.accountManager.copyText(url)}
        onOpenUrl={(url) => window.accountManager.openExternalUrl(url)}
        onQuickAddFinish={handleQuickAddFinish}
        onCancelOrClose={() => window.accountManager.cancelWorkflow()}
      />
    </div>
  );
}
