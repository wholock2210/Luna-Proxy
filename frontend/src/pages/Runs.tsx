import React, {useEffect, useMemo, useState} from 'react';
import {useI18n} from '../i18n';

type RunContext = {
  id: string;
  status: string;
  createdAt: number;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  sessionId?: string;
  providerId: string;
  accountId?: string;
  workerId?: string;
  networkProfileId?: string;
  outboundIp?: string;
  providerChatId?: string;
  model: string;
  stream: boolean;
  activeTaskPreview?: string;
  queueReason?: string;
  error?: string;
};
const LIST_BATCH_SIZE = 50;

export default function Runs() {
  const {t} = useI18n();
  const [runs, setRuns] = useState<RunContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunContext | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [visibleCount, setVisibleCount] = useState(LIST_BATCH_SIZE);

  useEffect(() => { loadRuns(); }, []);
  useEffect(() => {
    setVisibleCount(LIST_BATCH_SIZE);
  }, [runs]);

  const renderedRuns = useMemo(
    () => runs.slice(0, visibleCount),
    [runs, visibleCount],
  );

  async function loadRuns() {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/runs?limit=2000');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRuns(await res.json());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('runs.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  async function cancelRun(runId: string) {
    try {
      await fetch(`/api/runs/${runId}/cancel`, {method: 'POST'});
      loadRuns();
    } catch {}
  }

  async function deleteRun(runId: string) {
    if (!confirm(t('runs.confirmDelete'))) return;
    try {
      const res = await fetch(`/api/runs/${runId}`, {method: 'DELETE'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (selectedRun?.id === runId) setSelectedRun(null);
      await loadRuns();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('runs.deleteFailed'));
    }
  }

  async function deleteRuns() {
    if (!confirm(t('runs.confirmDeleteAll'))) return;
    setDeleting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/runs', {method: 'DELETE'});
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSelectedRun(null);
      setRuns([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('runs.deleteAllFailed'));
    } finally {
      setDeleting(false);
    }
  }

  function statusClass(status: string) {
    if (status === 'completed') return 'status-alive';
    if (status === 'streaming') return 'status-alive';
    if (status === 'failed' || status === 'cancelled') return 'status-dead';
    return 'status-warn';
  }

  function handleListScroll(event: React.UIEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const remaining = target.scrollHeight - target.scrollTop - target.clientHeight;
    if (remaining < 160 && visibleCount < runs.length) {
      setVisibleCount(count => Math.min(count + LIST_BATCH_SIZE, runs.length));
    }
  }

  return (
    <section aria-labelledby="runs-title" className="page-panel runs-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('runs.eyebrow')}</p>
          <h2 id="runs-title">{t('nav.runs')}</h2>
        </div>
        <div className="action-row">
          <button onClick={loadRuns} disabled={loading}>{loading ? t('common.loading') : t('common.refresh')}</button>
          <button className="danger" onClick={deleteRuns} disabled={deleting}>{deleting ? t('common.deleting') : t('common.delete')}</button>
        </div>
      </div>

      {message ? <p className="muted">{message}</p> : null}
      {!loading && runs.length === 0 ? (
        <div className="surface-card" style={{marginBottom: 16, padding: 16}}>
          <h4 style={{marginBottom: 8}}>{t('runs.emptyTitle')}</h4>
          <p className="muted">{t('runs.emptyHint')}</p>
        </div>
      ) : null}

      <div className="table-wrap list-scroll" onScroll={handleListScroll}>
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('label.time')}</th>
              <th>{t('label.status')}</th>
              <th>{t('label.provider')}</th>
              <th>{t('label.account')}</th>
              <th>{t('label.model')}</th>
              <th>{t('label.session')}</th>
              <th>{t('label.chatId')}</th>
              <th>{t('label.queueReason')}</th>
              <th>{t('label.task')}</th>
              <th>{t('label.duration')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {renderedRuns.map(r => (
              <tr key={r.id} className="clickable-row"
                onClick={() => setSelectedRun(selectedRun?.id === r.id ? null : r)}
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedRun(selectedRun?.id === r.id ? null : r); }}>
                <td>{new Date(r.createdAt).toLocaleString()}</td>
                <td><span className={`status-pill ${statusClass(r.status)}`}>{r.status}</span></td>
                <td style={{fontSize: '0.85em'}}>{r.providerId}</td>
                <td style={{fontSize: '0.85em'}}>{r.accountId || '-'}</td>
                <td style={{fontSize: '0.85em'}}>{r.model}</td>
                <td style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{r.sessionId ? r.sessionId.slice(0, 8) + '...' : '-'}</td>
                <td style={{fontSize: '0.85em'}}>{r.providerChatId ? r.providerChatId.slice(0, 8) + '...' : '-'}</td>
                <td style={{fontSize: '0.85em'}}>{r.queueReason || '-'}</td>
                <td className="log-message">{r.activeTaskPreview || '-'}</td>
                <td>{typeof r.completedAt === 'number' && typeof r.startedAt === 'number' ? `${r.completedAt - r.startedAt}ms` : '-'}</td>
                <td>
                  {r.status === 'streaming' || r.status === 'queued' || r.status === 'routing' ? (
                    <button onClick={(e) => { e.stopPropagation(); cancelRun(r.id); }} style={{fontSize: '0.8em', padding: '2px 8px'}}>{t('common.cancel')}</button>
                  ) : null}
                  <button className="danger" onClick={(e) => { e.stopPropagation(); deleteRun(r.id); }} style={{fontSize: '0.8em', padding: '2px 8px', marginLeft: 6}}>{t('common.delete')}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {runs.length > renderedRuns.length ? (
        <p className="muted list-lazy-status">{t('common.showingOf', {shown: renderedRuns.length, total: runs.length})}</p>
      ) : null}

      {selectedRun ? (
        <div className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="run-detail-title" onClick={() => setSelectedRun(null)}>
          <aside className="detail-panel" onClick={(e) => e.stopPropagation()}>
          <button className="modal-close-btn" aria-label={t('common.close')} onClick={() => setSelectedRun(null)}>×</button>
          <div className="detail-heading">
            <p className="eyebrow">{t('runs.detail')}</p>
            <h3 id="run-detail-title">{selectedRun.model}</h3>
            <p className="muted">{new Date(selectedRun.createdAt).toLocaleString()}</p>
          </div>
          <div className="action-row" style={{marginBottom: 16}}>
            {selectedRun.status === 'streaming' || selectedRun.status === 'queued' || selectedRun.status === 'routing' ? (
              <button onClick={() => cancelRun(selectedRun.id)}>{t('common.cancel')}</button>
            ) : null}
            <button className="danger" onClick={() => deleteRun(selectedRun.id)}>{t('common.delete')}</button>
          </div>
          <dl className="detail-grid">
            <dt>ID</dt><dd style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{selectedRun.id}</dd>
            <dt>{t('label.status')}</dt><dd><span className={`status-pill ${statusClass(selectedRun.status)}`}>{selectedRun.status}</span></dd>
            <dt>{t('label.created')}</dt><dd>{new Date(selectedRun.createdAt).toLocaleString()}</dd>
            <dt>{t('label.queued')}</dt><dd>{new Date(selectedRun.queuedAt).toLocaleString()}</dd>
            <dt>{t('label.started')}</dt><dd>{selectedRun.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : '-'}</dd>
            <dt>{t('label.completed')}</dt><dd>{selectedRun.completedAt ? new Date(selectedRun.completedAt).toLocaleString() : '-'}</dd>
            <dt>{t('label.provider')}</dt><dd>{selectedRun.providerId}</dd>
            <dt>{t('label.account')}</dt><dd>{selectedRun.accountId || '-'}</dd>
            <dt>{t('label.worker')}</dt><dd>{selectedRun.workerId || '-'}</dd>
            <dt>{t('label.networkProfile')}</dt><dd>{selectedRun.networkProfileId || '-'}</dd>
            <dt>{t('label.outboundIp')}</dt><dd>{selectedRun.outboundIp || '-'}</dd>
            <dt>{t('label.providerChat')}</dt><dd style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{selectedRun.providerChatId || '-'}</dd>
            <dt>Session ID</dt><dd style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{selectedRun.sessionId || '-'}</dd>
            <dt>{t('label.model')}</dt><dd>{selectedRun.model}</dd>
            <dt>{t('label.stream')}</dt><dd>{selectedRun.stream ? t('common.yes') : t('common.no')}</dd>
            <dt>{t('label.queueReason')}</dt><dd>{selectedRun.queueReason || '-'}</dd>
            <dt>{t('label.error')}</dt><dd style={{color: 'var(--color-danger)'}}>{selectedRun.error || '-'}</dd>
            <dt>{t('label.task')}</dt><dd>{selectedRun.activeTaskPreview || '-'}</dd>
            <dt>{t('label.duration')}</dt><dd>{typeof selectedRun.completedAt === 'number' && typeof selectedRun.startedAt === 'number' ? `${selectedRun.completedAt - selectedRun.startedAt}ms` : '-'}</dd>
          </dl>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
