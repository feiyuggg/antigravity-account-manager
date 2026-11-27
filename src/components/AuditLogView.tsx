import { Trash2 } from 'lucide-react';
import type { AuditEntry } from '../../shared/types';

interface AuditLogViewProps {
  entries: AuditEntry[];
  onClear: () => void;
}

export function AuditLogView({ entries, onClear }: AuditLogViewProps) {
  return (
    <div className="container">
      <div className="section-header">
        <div>
          <h2 className="section-title">ACP 与环境隔离审计日志</h2>
          <div className="section-subtitle">
            透明记录每一次 `agy acp` 调用、环境变量初始化与 Antigravity 启停操作，确认无任何额度/凭证接口调用。
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={entries.length === 0}
          onClick={onClear}
        >
          <Trash2 size={13} />
          清空日志
        </button>
      </div>

      <section className="card audit-table-wrap">
        {entries.length === 0 ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--text-muted)',
              fontSize: '13px',
            }}
          >
            暂无操作记录。
          </div>
        ) : (
          <table className="audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>操作</th>
                <th>状态</th>
                <th>耗时</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((item) => (
                <tr key={item.id}>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(item.timestamp).toLocaleTimeString()}
                  </td>
                  <td>
                    <span className="chip">{item.source}</span>
                  </td>
                  <td className="mono">{item.operation}</td>
                  <td>
                    <span
                      className={`chip ${
                        item.status === 'ok'
                          ? 'good'
                          : item.status === 'error'
                            ? 'warn'
                            : 'accent'
                      }`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {typeof item.durationMs === 'number' ? `${item.durationMs}ms` : '—'}
                  </td>
                  <td style={{ color: 'var(--text-secondary)', wordBreak: 'break-all' }}>
                    {item.detail || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
