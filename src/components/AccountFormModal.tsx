import { X } from 'lucide-react';
import { FormEvent, useState } from 'react';
import type {
  AccountProfile,
  AccountSaveInput,
  AuthMode,
  IsolationMode,
} from '../../shared/types';

const PRESET_COLORS = [
  '#3b82f6',
  '#10b981',
  '#8b5cf6',
  '#f59e0b',
  '#ec4899',
  '#06b6d4',
  '#ef4444',
];

interface AccountFormModalProps {
  initial?: AccountProfile;
  defaultAuthMode: AuthMode;
  hasSystemSlot: boolean;
  defaultIsolationMode?: IsolationMode;
  onClose: () => void;
  onSave: (input: AccountSaveInput) => Promise<void>;
}

export function AccountFormModal({
  initial,
  defaultAuthMode,
  hasSystemSlot,
  defaultIsolationMode,
  onClose,
  onSave,
}: AccountFormModalProps) {
  const [nickname, setNickname] = useState(initial?.nickname ?? '');
  const [emailHint, setEmailHint] = useState(initial?.emailHint ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [color, setColor] = useState(initial?.color ?? PRESET_COLORS[0]);
  const [isolationMode, setIsolationMode] = useState<IsolationMode>(
    initial?.isolationMode ?? defaultIsolationMode ?? 'isolated',
  );
  const [preferredAuthMode, setPreferredAuthMode] = useState<AuthMode>(
    initial?.preferredAuthMode ?? defaultAuthMode,
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!nickname.trim()) {
      setError('请输入账号槽位名称');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        id: initial?.id,
        nickname,
        emailHint,
        note,
        color,
        isolationMode,
        preferredAuthMode,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{initial ? '编辑账号槽位' : '添加 Antigravity 账号槽位'}</h3>
          <button type="button" className="btn icon-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div className="form-field">
            <label htmlFor="acc-nickname">槽位名称 *</label>
            <input
              id="acc-nickname"
              className="input"
              placeholder="例如：工作号 / 个人号 A / 备用号 B"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              autoFocus
            />
          </div>

          <div className="form-field">
            <label htmlFor="acc-email">Google 邮箱（留空即可，首次 ACP 登录后将自动识别填入）</label>
            <input
              id="acc-email"
              className="input"
              placeholder="留空自动识别，或手动填写如 alice@gmail.com"
              value={emailHint}
              onChange={(e) => setEmailHint(e.target.value)}
            />
          </div>

          <div className="form-field">
            <label htmlFor="acc-isolation">环境变量隔离模式</label>
            <select
              id="acc-isolation"
              className="select"
              value={isolationMode}
              disabled={Boolean(initial)}
              onChange={(e) => setIsolationMode(e.target.value as IsolationMode)}
            >
              <option value="isolated">
                独立环境变量槽位（推荐：独立 HOME + CFFIXED_USER_HOME + 独立 Keychain）
              </option>
              <option value="system" disabled={hasSystemSlot && initial?.isolationMode !== 'system'}>
                系统默认环境（复用当前 macOS 主目录 ~/.gemini 与默认钥匙串）
              </option>
            </select>
            {initial && (
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                创建后不可更改隔离模式，以确保环境变量目录稳定。
              </div>
            )}
          </div>

          <div className="form-field">
            <label htmlFor="acc-auth">首次 `agy acp` 登录方式</label>
            <select
              id="acc-auth"
              className="select"
              value={preferredAuthMode}
              onChange={(e) => setPreferredAuthMode(e.target.value as AuthMode)}
            >
              <option value="terminal-login">
                agy acp --login（推荐多账号：复制链接到对应 Chrome Profile 授权）
              </option>
              <option value="oauth-personal">
                agy acp authenticate: oauth-personal（拉起默认浏览器个人账号授权）
              </option>
              <option value="oauth-business">
                agy acp authenticate: oauth-business（企业 / Google Cloud 账号）
              </option>
            </select>
          </div>

          <div className="form-field">
            <label>卡片标识色</label>
            <div className="color-swatches">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`color-swatch ${color === c ? 'selected' : ''}`}
                  style={{ background: c }}
                  onClick={() => setColor(c)}
                  aria-label={`选择颜色 ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="acc-note">备注（可选）</label>
            <textarea
              id="acc-note"
              className="textarea"
              rows={2}
              placeholder="例如：主力开发环境 / 对应的 Chrome Profile 名称"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>

          {error && (
            <div className="notice-banner warn">
              <span>{error}</span>
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={submitting}>
              {submitting ? '准备中...' : '保存槽位'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
