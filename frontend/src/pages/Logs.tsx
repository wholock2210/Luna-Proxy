import React, {useEffect, useMemo, useState} from 'react';
import {useI18n} from '../i18n';

type LogItem = {level: string; message: string; timestamp: number};
type DetailTab = 'metrics' | 'requestHeaders' | 'responseHeaders' | 'response' | 'prompt';
const LIST_BATCH_SIZE = 50;

function parseLog(log: LogItem): Record<string, any> {
  try {
    return JSON.parse(log.message);
  } catch {
    return {message: log.message};
  }
}

function formatLogText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        const role = (item as any).role ? `${(item as any).role}: ` : '';
        const content = (item as any).content;
        if (typeof content === 'string') return `${role}${content}`;
        return `${role}${JSON.stringify(content ?? item)}`;
      }
      return String(item);
    }).join('\n');
  }
  if (typeof value === 'object') {
    const content = (value as any).content;
    if (typeof content === 'string') return content;
    return JSON.stringify(value);
  }
  return String(value);
}

export default function Logs() {
  const {t} = useI18n();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'info' | 'error'>('all');
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [selectedLog, setSelectedLog] = useState<LogItem | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('metrics');
  const [selectedPromptRole, setSelectedPromptRole] = useState<string>('user');
  const [visibleCount, setVisibleCount] = useState(LIST_BATCH_SIZE);

  async function loadLogs() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/logs?limit=1000');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error('Invalid logs response');
      }
      setLogs(data);
    } catch (error) {
      setLogs([]);
      setMessage(error instanceof Error ? error.message : `${t('common.loadFailed')} ${t('nav.logs')}`);
    } finally {
      setLoading(false);
    }
  }

  async function deleteLogs() {
    setDeleting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/logs', {method: 'DELETE'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLogs([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${t('common.deleteFailed')} ${t('nav.logs')}`);
    } finally {
      setDeleting(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, []);

  const visibleLogs = useMemo(
    () => logs.filter(log => filter === 'all' || log.level === filter),
    [logs, filter],
  );
  const renderedLogs = useMemo(
    () => visibleLogs.slice(0, visibleCount),
    [visibleLogs, visibleCount],
  );
  const selectedMeta = selectedLog ? parseLog(selectedLog) : null;

  useEffect(() => {
    setVisibleCount(LIST_BATCH_SIZE);
  }, [filter, logs]);

  useEffect(() => {
    if (!selectedMeta) return;
    const items = parsePromptMessages(selectedMeta);
    const roles = Array.from(new Set(items.map((p: any) => p.role)));
    const defaultRole = roles.includes('user') ? 'user' : (roles[0] || 'user');
    setSelectedPromptRole(defaultRole);
  }, [selectedMeta]);

  function openLog(log: LogItem) {
    setSelectedLog(log);
    setActiveTab('metrics');
  }

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remaining < 160 && visibleCount < visibleLogs.length) {
      setVisibleCount(count => Math.min(count + LIST_BATCH_SIZE, visibleLogs.length));
    }
  }

  function renderJsonBlock(value: unknown, emptyText: string) {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0)
    ) {
      return <p className="muted">{emptyText}</p>;
    }
    return <pre className="detail-pre">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
  }

  function parsePromptMessages(meta: Record<string, any>) {
    const raw = meta?.prompt_messages ?? meta?.prompt ?? meta?.requestBody ?? meta?.request?.body ?? meta?.message ?? null;
    try {
      if (!raw) return [{role: 'user', content: ''}];
      if (Array.isArray(raw)) {
        return raw.map((m: any, i: number) => {
          if (typeof m === 'string') return {role: 'user', content: m, index: i};
          const role = String(m.role || m.roleName || m.role_label || 'user').toLowerCase();
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? m, null, 2);
          return {role, content, index: i};
        });
      }
      if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if ((trimmed.startsWith('{') || trimmed.startsWith('['))) {
          const parsed = JSON.parse(raw);
          return parsePromptMessages({prompt: parsed});
        }
        return [{role: 'user', content: raw}];
      }
      if (typeof raw === 'object') {
        if (Array.isArray(raw.messages)) return parsePromptMessages({prompt: raw.messages});
        const role = String(raw.role || 'user').toLowerCase();
        const content = typeof raw.content === 'string' ? raw.content : JSON.stringify(raw.content ?? raw, null, 2);
        return [{role, content}];
      }
    } catch (e) {
      return [{role: 'user', content: String(raw)}];
    }
    return [{role: 'user', content: String(raw)}];
  }

  return (
    <section aria-labelledby="logs-title" className="page-panel logs-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('logs.eyebrow')}</p>
          <h2 id="logs-title">{t('nav.logs')}</h2>
        </div>
        <div className="action-row">
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)} aria-label={t('logs.filter')}>
            <option value="all">{t('logs.allLevels')}</option>
            <option value="info">Info</option>
            <option value="error">Error</option>
          </select>
          <button onClick={loadLogs} disabled={loading}>{loading ? t('common.loading') : t('common.refresh')}</button>
          <button className="danger" onClick={deleteLogs} disabled={deleting}>{deleting ? t('common.deleting') : t('common.delete')}</button>
        </div>
      </div>

      {message ? <p className="muted">{message}</p> : null}
      {!loading && visibleLogs.length === 0 ? <p className="muted">{t('logs.empty')}</p> : null}

      <div className="table-wrap list-scroll" onScroll={handleListScroll}>
        <table className="data-table logs-table">
          <thead>
            <tr>
              <th>{t('label.time')}</th>
              <th>{t('label.level')}</th>
              <th>{t('label.path')}</th>
              <th>{t('label.status')}</th>
              <th>{t('label.model')}</th>
              <th>{t('logs.promptMessage')}</th>
              <th>{t('logs.latency')}</th>
            </tr>
          </thead>
          <tbody>
            {renderedLogs.map((log, index) => {
              const meta = parseLog(log);
              return (
                <tr
                  key={`${log.timestamp}-${index}`}
                  className="clickable-row"
                  onClick={() => openLog(log)}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') openLog(log);
                  }}
                >
                  <td>{new Date(log.timestamp).toLocaleString()}</td>
                  <td><span className={`status-pill status-${log.level === 'error' ? 'dead' : 'alive'}`}>{log.level}</span></td>
                  <td>{meta.path || '-'}</td>
                  <td>{meta.status || '-'}</td>
                  <td>{meta.model || '-'}</td>
                  <td className="log-message">{formatLogText(meta.prompt || meta.prompt_messages || meta.error || meta.message || log.message)}</td>
                  <td>{typeof meta.durationMs === 'number' ? `${meta.durationMs}ms` : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {visibleLogs.length > renderedLogs.length ? (
        <p className="muted list-lazy-status">{t('common.showingOf', {shown: renderedLogs.length, total: visibleLogs.length})}</p>
      ) : null}

      {selectedLog && selectedMeta ? (
        <div className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="log-detail-title" onClick={() => setSelectedLog(null)}>
          <aside className="detail-panel" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" aria-label={t('common.close')} onClick={() => setSelectedLog(null)}>×</button>
            <div className="detail-heading">
              <p className="eyebrow">{t('logs.detail')}</p>
              <h3 id="log-detail-title">{selectedMeta.path || selectedMeta.message || t('logs.entry')}</h3>
              <p className="muted">{new Date(selectedLog.timestamp).toLocaleString()}</p>
            </div>

            <div className="detail-tabs" role="tablist" aria-label={t('logs.tabs')}>
              <button className={activeTab === 'metrics' ? 'tab active' : 'tab'} onClick={() => setActiveTab('metrics')}>{t('logs.metrics')}</button>
              <button className={activeTab === 'requestHeaders' ? 'tab active' : 'tab'} onClick={() => setActiveTab('requestHeaders')}>{t('logs.requestHeaders')}</button>
              <button className={activeTab === 'responseHeaders' ? 'tab active' : 'tab'} onClick={() => setActiveTab('responseHeaders')}>{t('logs.responseHeaders')}</button>
              <button className={activeTab === 'response' ? 'tab active' : 'tab'} onClick={() => setActiveTab('response')}>{t('logs.response')}</button>
              <button className={activeTab === 'prompt' ? 'tab active' : 'tab'} onClick={() => setActiveTab('prompt')}>{t('logs.prompt')}</button>
            </div>

            <div className="detail-content">
              {activeTab === 'metrics' ? (
                <dl className="detail-grid">
                  <dt>{t('label.level')}</dt><dd>{selectedLog.level}</dd>
                  <dt>{t('label.status')}</dt><dd>{selectedMeta.status || '-'}</dd>
                  <dt>{t('label.model')}</dt><dd>{selectedMeta.model || '-'}</dd>
                  <dt>{t('label.stream')}</dt><dd>{String(selectedMeta.stream ?? '-')}</dd>
                  <dt>{t('logs.thinkingMode')}</dt><dd>{selectedMeta.thinking_mode || '-'}</dd>
                  <dt>{t('logs.reasoningEffort')}</dt><dd>{selectedMeta.reasoning_effort || '-'}</dd>
                  <dt>{t('logs.files')}</dt><dd>{selectedMeta.files ?? '-'}</dd>
                  <dt>{t('label.overflow')}</dt><dd>{String(selectedMeta.overflow ?? '-')}</dd>
                  <dt>{t('logs.sanitized')}</dt><dd>{selectedMeta.sanitized === undefined ? '-' : String(selectedMeta.sanitized)}</dd>
                  <dt>{t('logs.detectedClient')}</dt><dd>{selectedMeta.sanitizerMeta?.client || '-'}</dd>
                  <dt>{t('logs.responseContract')}</dt><dd>{selectedMeta.sanitizerMeta?.clientResponseContract || '-'}</dd>
                  <dt>{t('logs.activeTaskIdx')}</dt><dd>{selectedMeta.sanitizerMeta?.activeTaskMessageIndex ?? '-'}</dd>
                  <dt>{t('logs.activeTaskPreview')}</dt><dd>{selectedMeta.sanitizerMeta?.activeTask?.textPreview?.slice(0, 100) || '-'}</dd>
                  <dt>{t('logs.activeTaskSource')}</dt><dd>{selectedMeta.sanitizerMeta?.activeTask?.source || '-'}</dd>
                  <dt>{t('logs.activeTaskPartIndex')}</dt><dd>{selectedMeta.sanitizerMeta?.activeTask?.fromPartIndex ?? '-'}</dd>
                  <dt>{t('logs.overflowFile')}</dt><dd>{selectedMeta.sanitizerMeta?.overflowFile || '-'}</dd>
                  <dt>{t('logs.keptStripped')}</dt><dd>{selectedMeta.sanitizerMeta ? `${selectedMeta.sanitizerMeta.keptMessageCount} / ${selectedMeta.sanitizerMeta.strippedMessageCount}` : '-'}</dd>
                  <dt>{t('logs.clientRetryDetected')}</dt><dd>{selectedMeta.sanitizerMeta?.clientRetryDetected === undefined ? '-' : String(selectedMeta.sanitizerMeta.clientRetryDetected)}</dd>
                  <dt>{t('logs.clientRetrySource')}</dt><dd>{selectedMeta.sanitizerMeta?.clientRetrySource || '-'}</dd>
                  <dt>{t('logs.snapshotIncluded')}</dt><dd>{selectedMeta.sanitizerMeta?.projectSnapshotIncluded === undefined ? '-' : String(selectedMeta.sanitizerMeta.projectSnapshotIncluded)}</dd>
                  <dt>{t('logs.removedContainerConf')}</dt><dd>{selectedMeta.sanitizerMeta?.removedCounts?.containerConfusion ?? '-'}</dd>
                  <dt>{t('logs.removedAutoReminder')}</dt><dd>{selectedMeta.sanitizerMeta?.removedCounts?.automatedReminder ?? '-'}</dd>
                  <dt>{t('logs.removedPartialReminder')}</dt><dd>{selectedMeta.sanitizerMeta?.removedCounts?.partialAutomatedReminder ?? '-'}</dd>
                  <dt>{t('logs.removedAssistantFail')}</dt><dd>{selectedMeta.sanitizerMeta?.removedCounts?.assistantFailureEcho ?? '-'}</dd>
                  <dt>{t('logs.removedDupAssistant')}</dt><dd>{selectedMeta.sanitizerMeta?.removedCounts?.duplicateAssistant ?? '-'}</dd>
                  <dt>{t('logs.partialNoise')}</dt><dd>{selectedMeta.sanitizerMeta?.partialNoise?.length ? selectedMeta.sanitizerMeta.partialNoise.map((p: any) => `msg[${p.messageIndex}]: ${p.reason}`).join('; ') : '-'}</dd>
                  <dt>{t('logs.sessionMode')}</dt><dd>{selectedMeta.session?.mode || '-'}</dd>
                  <dt>{t('logs.sessionResolveReason')}</dt><dd>{selectedMeta.session?.resolveReason || '-'}</dd>
                  <dt>{t('logs.sessionExplicit')}</dt><dd>{selectedMeta.session?.explicit === undefined ? '-' : String(selectedMeta.session.explicit)}</dd>
                  <dt>{t('logs.sessionSource')}</dt><dd>{selectedMeta.session?.source || '-'}</dd>
                  <dt>{t('logs.sessionWorkspace')}</dt><dd>{selectedMeta.session?.workspace || '-'}</dd>
                  <dt>{t('logs.sessionThread')}</dt><dd>{selectedMeta.session?.threadId || '-'}</dd>
                  <dt>{t('logs.sessionProviderId')}</dt><dd>{selectedMeta.session?.providerSessionId || '-'}</dd>
                  <dt>{t('logs.dedupeMeta')}</dt><dd>{selectedMeta.sanitizerMeta?.persistSkipped ? `skipped=${selectedMeta.sanitizerMeta.persistSkipped.skipped} persisted=${selectedMeta.sanitizerMeta.persistSkipped.persisted}` : '-'}</dd>
                  <dt>{t('logs.latency')}</dt><dd>{typeof selectedMeta.durationMs === 'number' ? `${selectedMeta.durationMs}ms` : '-'}</dd>
                  <dt>{t('logs.prompt')}</dt><dd>{formatLogText(selectedMeta.prompt || selectedMeta.prompt_messages || selectedMeta.error || selectedMeta.message || selectedLog.message)}</dd>
                </dl>
              ) : null}
              {activeTab === 'prompt' ? (
                (() => {
                  const promptItems = selectedMeta ? parsePromptMessages(selectedMeta) : [{role: 'user', content: ''}];
                  const roles = Array.from(new Set(promptItems.map((p: any) => p.role)));
                  if (!roles.includes('user')) roles.unshift('user');
                  const visible = promptItems.filter((p: any) => p.role === selectedPromptRole) || [];
                  return (
                    <div>
                      <div className="provider-action-row" style={{marginBottom: 12}}>
                        {roles.map((r: string) => (
                          <button
                            key={r}
                            className={`provider-action-btn ${selectedPromptRole === r ? 'active' : ''}`}
                            onClick={() => setSelectedPromptRole(r)}
                            aria-pressed={selectedPromptRole === r}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                      {visible.length === 0 ? (
                        <p className="muted">{t('logs.noPrompts')}</p>
                      ) : visible.length === 1 ? (
                        <pre className="detail-pre">{visible[0].content}</pre>
                      ) : (
                        <div>
                          {visible.map((v: any, idx: number) => (
                            <div key={idx} style={{marginBottom: 12}}>
                              <div style={{fontSize: '0.9rem', color: 'var(--color-text-secondary)', marginBottom: 6}}>{t('common.message')} {v.index ?? idx}</div>
                              <pre className="detail-pre">{v.content}</pre>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()
              ) : null}
              {activeTab === 'requestHeaders'
                ? renderJsonBlock(selectedMeta.requestHeaders || selectedMeta.request_headers, t('logs.noRequestHeaders'))
                : null}
              {activeTab === 'responseHeaders'
                ? renderJsonBlock(selectedMeta.responseHeaders || selectedMeta.response_headers, t('logs.noResponseHeaders'))
                : null}
              {activeTab === 'response'
                ? renderJsonBlock(selectedMeta.response || selectedMeta.responseBody || selectedMeta.error, t('logs.noResponseBody'))
                : null}
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
