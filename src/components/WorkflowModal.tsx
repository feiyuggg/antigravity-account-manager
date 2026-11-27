import { Check, Copy, ExternalLink, Loader2, Power, Send, X } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import type { AccountProfile, WorkflowState } from '../../shared/types';

interface WorkflowModalProps {
  workflowState: WorkflowState;
  targetAccount?: AccountProfile;
  onSubmitCode: (code: string) => Promise<void>;
  onCopyUrl: (url: string) => Promise<void>;
  onOpenUrl: (url: string) => Promise<void>;
  onQuickAddFinish: (
    account: AccountProfile,
    updates: { nickname: string; emailHint: string },
    switchNow: boolean,
  ) => Promise<void>;
  onCancelOrClose: () => Promise<void>;
}

const PHASE_ORDER = [
  'preparing_env',
  'probing',
  'awaiting_auth',
  'quitting_app',
  'launching_app',
  'done',
] as const;

function getStepState(currentPhase: WorkflowState['phase'], targetPhase: string): string {
  if (currentPhase === targetPhase) return 'active';
  const curIdx = PHASE_ORDER.indexOf(currentPhase as (typeof PHASE_ORDER)[number]);
  const tgtIdx = PHASE_ORDER.indexOf(targetPhase as (typeof PHASE_ORDER)[number]);
  if (curIdx !== -1 && tgtIdx !== -1 && curIdx > tgtIdx) return 'done';
  if (currentPhase === 'done') return 'done';
  return '';
}

export function WorkflowModal({
  workflowState,
  targetAccount,
  onSubmitCode,
  onCopyUrl,
  onOpenUrl,
  onQuickAddFinish,
  onCancelOrClose,
}: WorkflowModalProps) {
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [submittingCode, setSubmittingCode] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const [quickNickname, setQuickNickname] = useState('');
  const [quickEmailHint, setQuickEmailHint] = useState('');
  const [finishingQuickAdd, setFinishingQuickAdd] = useState(false);

  useEffect(() => {
    if (targetAccount) {
      setQuickNickname(targetAccount.nickname);
      setQuickEmailHint(targetAccount.emailHint ?? '');
    }
  }, [targetAccount?.id, targetAccount?.nickname, targetAccount?.emailHint, workflowState.phase]);

  if (workflowState.phase === 'idle') {
    return null;
  }

  const isTerminalFinished =
    workflowState.phase === 'done' ||
    workflowState.phase === 'error' ||
    workflowState.phase === 'cancelled';

  const isQuickAddDone =
    workflowState.kind === 'quick_add' &&
    workflowState.phase === 'done' &&
    Boolean(targetAccount);

  const modalTitle =
    workflowState.kind === 'quick_add'
      ? '一键添加账号（ACP 浏览器认证）'
      : workflowState.kind === 'login'
        ? 'ACP 隔离环境登录'
        : '切换账号并重启 Antigravity';

  const handleCopy = async () => {
    if (!workflowState.detectedUrl) return;
    await onCopyUrl(workflowState.detectedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleSubmitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setSubmittingCode(true);
    setSubmitErr(null);
    try {
      await onSubmitCode(code);
      setCode('');
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingCode(false);
    }
  };

  const handleQuickFinishClick = async (switchNow: boolean) => {
    if (!targetAccount) return;
    setFinishingQuickAdd(true);
    try {
      await onQuickAddFinish(
        targetAccount,
        { nickname: quickNickname, emailHint: quickEmailHint },
        switchNow,
      );
    } finally {
      setFinishingQuickAdd(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-panel" style={{ maxWidth: '620px' }}>
        <div className="modal-header">
          <h3 className="modal-title">
            {modalTitle}
            {targetAccount ? `：${targetAccount.nickname}` : ''}
          </h3>
          <button
            type="button"
            className="btn icon-btn"
            disabled={finishingQuickAdd}
            onClick={() => void onCancelOrClose()}
          >
            <X size={15} />
          </button>
        </div>

        <div className="stepper">
          <div className={`step-pill ${getStepState(workflowState.phase, 'preparing_env')}`}>
            <span>1. 准备隔离环境</span>
          </div>
          <div className={`step-pill ${getStepState(workflowState.phase, 'probing')}`}>
            <span>2. ACP 会话检测/授权</span>
          </div>
          {workflowState.restartAfterLogin !== false && (
            <>
              <div className={`step-pill ${getStepState(workflowState.phase, 'quitting_app')}`}>
                <span>3. 退出 Antigravity</span>
              </div>
              <div className={`step-pill ${getStepState(workflowState.phase, 'launching_app')}`}>
                <span>4. 注入环境重启</span>
              </div>
            </>
          )}
        </div>

        <div
          className={`notice-banner ${
            workflowState.phase === 'error'
              ? 'warn'
              : workflowState.phase === 'done'
                ? 'good'
                : 'accent'
          }`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            {!isTerminalFinished && <Loader2 size={15} className="spin" />}
            <span>{workflowState.message}</span>
          </div>
        </div>

        {workflowState.error && (
          <div className="notice-banner warn">
            <span>错误详情：{workflowState.error}</span>
          </div>
        )}

        {workflowState.phase === 'awaiting_auth' && workflowState.authMode === 'terminal-login' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {workflowState.detectedUrl && (
              <div
                className="card"
                style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}
              >
                <div style={{ fontSize: '12px', fontWeight: 600 }}>
                  官方 `agy acp --login` 授权链接（建议复制到对应 Google 账号的 Chrome Profile 打开）：
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-muted)',
                    wordBreak: 'break-all',
                  }}
                >
                  {workflowState.detectedUrl}
                </div>
                <div className="action-group">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleCopy()}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? '已复制链接' : '复制授权链接'}
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void onOpenUrl(workflowState.detectedUrl!)}
                  >
                    <ExternalLink size={12} />
                    默认浏览器打开
                  </button>
                </div>
              </div>
            )}

            {workflowState.terminalOutput && (
              <div className="terminal-box">{workflowState.terminalOutput}</div>
            )}

            <form onSubmit={handleSubmitCode} style={{ display: 'flex', gap: '8px' }}>
              <input
                className="input mono"
                placeholder="在此粘贴浏览器返回的授权码（Code）"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoFocus
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={submittingCode || !code.trim()}
              >
                <Send size={13} />
                {submittingCode ? '提交中' : '提交'}
              </button>
            </form>
            {submitErr && (
              <div className="notice-banner warn">
                <span>{submitErr}</span>
              </div>
            )}
          </div>
        )}

        {workflowState.phase === 'awaiting_auth' && workflowState.authMode !== 'terminal-login' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              官方 <code>agy acp</code> 已触发默认浏览器打开 Google 登录授权页。
              {targetAccount?.emailHint ? (
                <>
                  请在浏览器中选择账号 <strong>{targetAccount.emailHint}</strong> 完成授权。
                </>
              ) : (
                '请在浏览器中选择你要添加的 Google 账号并确认授权，完成后此窗口将自动继续。'
              )}
            </div>

            {workflowState.detectedUrl && (
              <div className="action-group">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void onOpenUrl(workflowState.detectedUrl!)}
                >
                  <ExternalLink size={12} />
                  未弹出浏览器？点此重新打开
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void handleCopy()}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? '已复制链接' : '复制登录链接'}
                </button>
              </div>
            )}
          </div>
        )}

        {isQuickAddDone && targetAccount && (
          <div
            className="card"
            style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}
          >
            <div style={{ fontSize: '12.5px', fontWeight: 650 }}>
              {targetAccount.emailHint
                ? `已自动识别登录邮箱：${targetAccount.emailHint}`
                : '可选：为刚登录的账号设置显示备注（不影响实际会话）'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div className="form-field">
                <label htmlFor="quick-nickname">槽位名称</label>
                <input
                  id="quick-nickname"
                  className="input"
                  value={quickNickname}
                  onChange={(e) => setQuickNickname(e.target.value)}
                  placeholder="例如：主力工作号"
                />
              </div>
              <div className="form-field">
                <label htmlFor="quick-email">邮箱提示（可选）</label>
                <input
                  id="quick-email"
                  className="input"
                  value={quickEmailHint}
                  onChange={(e) => setQuickEmailHint(e.target.value)}
                  placeholder="例如：user@gmail.com"
                />
              </div>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', flexWrap: 'wrap' }}>
          {isQuickAddDone ? (
            <>
              <button
                type="button"
                className="btn"
                disabled={finishingQuickAdd}
                onClick={() => void handleQuickFinishClick(false)}
              >
                完成保存（稍后切换）
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={finishingQuickAdd}
                onClick={() => void handleQuickFinishClick(true)}
              >
                <Power size={13} />
                立即切换并重启 Antigravity
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`btn ${isTerminalFinished ? 'btn-primary' : ''}`}
              onClick={() => void onCancelOrClose()}
            >
              {isTerminalFinished ? '完成' : '取消操作'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
