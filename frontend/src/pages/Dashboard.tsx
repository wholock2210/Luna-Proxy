import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useI18n} from '../i18n';

type ConfigData = {
  providers?: Array<{id: string; name?: string; credentials?: Record<string, string>}>;
  proxy?: {host?: string; port?: number; key?: string};
  models?: Array<{id: string; name: string}>;
  modelsUpdatedAt?: number;
  settings?: Record<string, any>;
};

type LogItem = {level: string; message: string; timestamp: number};
type LogStats = {total: number; errors: number; chatRequests: number};
type RuntimeRun = {
  id: string;
  status: string;
  providerId?: string;
  accountId?: string;
  providerChatId?: string;
  sessionId?: string;
  workerId?: string;
  startedAt?: number;
};
type RuntimeData = {
  config?: Record<string, any>;
  locks?: Record<string, {locked?: boolean; ownerId?: string; capacity?: number; capacityMax?: number; queued?: number}>;
  activeRuns?: RuntimeRun[];
  leases?: Array<{runId: string; capacityKeys: string[]; lockKeys: string[]; released: boolean}>;
  workers?: Array<{id: string; providerId?: string; status?: string; lastVerifiedIp?: string}>;
};

function parseLog(log: LogItem): Record<string, any> {
  try {
    return JSON.parse(log.message);
  } catch {
    return {message: log.message};
  }
}

// Icons for Dashboard Metrics
const Icons = {
  providers: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>,
  activity: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>,
  queue: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>,
  errors: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>,
  requests: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>,
  runs: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
};

export default function Dashboard() {
  const {t} = useI18n();
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [logStats, setLogStats] = useState<LogStats>({total: 0, errors: 0, chatRequests: 0});
  const [runtime, setRuntime] = useState<RuntimeData | null>(null);
  const [health, setHealth] = useState<'online' | 'offline' | 'checking'>('checking');
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const requestInFlight = useRef(false);

  async function loadDashboard(initial = false) {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (initial) setLoading(true);
    try {
      const [configRes, logsRes, statsRes, runtimeRes, healthRes] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/logs?limit=20'),
        fetch('/api/logs/stats'),
        fetch('/api/runtime'),
        fetch('/health'),
      ]);
      if (configRes.ok) setConfig(await configRes.json());
      if (logsRes.ok) setLogs(await logsRes.json());
      if (statsRes.ok) setLogStats(await statsRes.json());
      if (runtimeRes.ok) setRuntime(await runtimeRes.json());
      setHealth(healthRes.ok ? 'online' : 'offline');
      setLastUpdated(Date.now());
    } catch {
      setHealth('offline');
    } finally {
      if (initial) setLoading(false);
      requestInFlight.current = false;
    }
  }

  useEffect(() => {
    let active = true;
    const tick = async () => {
      if (!active) return;
      await loadDashboard(true);
    };
    void tick();
    const timer = window.setInterval(() => {
      void loadDashboard();
    }, 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const stats = useMemo(() => {
    const providers = config?.providers || [];
    const configuredProviders = providers.filter(p => p.credentials && Object.keys(p.credentials).length > 0);
    const activeRuns = runtime?.activeRuns || [];
    const locks = runtime?.locks || {};
    const queued = Object.values(locks).reduce((sum, lock) => sum + Number(lock.queued || 0), 0);
    const activeCapacity = Object.values(locks).reduce((sum, lock) => sum + Number(lock.capacity || 0), 0);
    return {
      providers: configuredProviders.length,
      activeRuns: activeRuns.length,
      queued,
      activeCapacity,
      requests: logStats.chatRequests,
      errors: logStats.errors,
    };
  }, [config, logStats, runtime]);

  return (
    <div className="page-panel dashboard-panel">
      <div className="page-heading">
        <div>
          <h2 id="dashboard-title">{t('dashboard.title')}</h2>
          <p className="muted">{t('dashboard.autoUpdate')} - {t('dashboard.status')}: {health === 'online' ? t('proxy.online') : health === 'offline' ? t('proxy.offline') : t('dashboard.checking')}</p>
        </div>
        <span className={`status-pill status-${health === 'online' ? 'alive' : health === 'offline' ? 'dead' : 'warn'}`}>
          {health === 'online' ? t('proxy.online') : health === 'offline' ? t('proxy.offline') : t('dashboard.checking')}
        </span>
      </div>

      <div className="metric-grid">
        <article className="metric-card">
          <div className="metric-icon">{Icons.providers}</div>
          <h3>{t('dashboard.configuredProviders')}</h3>
          <p className="metric-value">{stats.providers}</p>
          <p className="muted">{t('dashboard.availableAccountsHint')}</p>
        </article>
        
        <article className="metric-card">
          <div className="metric-icon" style={{color: 'var(--color-info)'}}>{Icons.activity}</div>
          <h3>{t('dashboard.capacityInUse')}</h3>
          <p className="metric-value">{stats.activeCapacity}</p>
          <p className="muted">{t('dashboard.currentConcurrentHint')}</p>
        </article>

        <article className="metric-card">
          <div className="metric-icon" style={{color: 'var(--color-warning)'}}>{Icons.queue}</div>
          <h3>{t('dashboard.queuedRuns')}</h3>
          <p className="metric-value">{stats.queued}</p>
          <p className="muted">{t('dashboard.queuedHint')}</p>
        </article>

        <article className="metric-card">
          <div className="metric-icon" style={{color: 'var(--color-danger)'}}>{Icons.errors}</div>
          <h3>{t('dashboard.recentErrors')}</h3>
          <p className="metric-value">{stats.errors}</p>
          <p className="muted">{t('dashboard.errorsHint')}</p>
        </article>

        <article className="metric-card">
          <div className="metric-icon" style={{color: 'var(--color-success)'}}>{Icons.requests}</div>
          <h3>{t('dashboard.recentRequests')}</h3>
          <p className="metric-value">{stats.requests}</p>
          <p className="muted">{t('dashboard.requestsHint')}</p>
        </article>

        <article className="metric-card">
          <div className="metric-icon" style={{color: 'var(--color-accent)'}}>{Icons.runs}</div>
          <h3>{t('dashboard.activeRuns')}</h3>
          <p className="metric-value">{stats.activeRuns}</p>
          <p className="muted">{t('dashboard.activeHint')}</p>
        </article>
      </div>

      <section className="surface-card">
        <div className="surface-card-head">
          <h3 style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{width: 4, height: 20, background: 'var(--color-accent)', borderRadius: 2, display: 'inline-block'}}></span>
            {t('dashboard.runtimeScheduler')}
          </h3>
          {lastUpdated ? <span className="muted">{t('common.updated')} {new Date(lastUpdated).toLocaleTimeString()}</span> : null}
        </div>
        
        {runtime?.activeRuns?.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('nav.runs')}</th>
                  <th>{t('label.status')}</th>
                  <th>{t('label.provider')}</th>
                  <th>{t('label.account')}</th>
                  <th>{t('label.session')}</th>
                  <th>{t('label.worker')}</th>
                  <th>{t('label.started')}</th>
                </tr>
              </thead>
              <tbody>
                {runtime.activeRuns.map((run) => (
                  <tr key={run.id}>
                    <td style={{fontFamily: 'monospace', fontSize: '0.85em', color: 'var(--color-accent)'}}>{run.id.slice(0, 8)}</td>
                    <td><span className={`status-pill status-${run.status === 'streaming' ? 'alive' : run.status === 'queued' ? 'warn' : 'alive'}`}>{run.status}</span></td>
                    <td>{run.providerId || '-'}</td>
                    <td>{run.accountId || '-'}</td>
                    <td style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{run.sessionId ? run.sessionId.slice(0, 8) : '-'}</td>
                    <td>{run.workerId || '-'}</td>
                    <td>{run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">{t('dashboard.noActiveRuns')}</p>
        )}
        
        {runtime?.locks && Object.keys(runtime.locks).length > 0 && (
          <div className="table-wrap" style={{marginTop: 'var(--space-4)'}}>
            <h4 style={{marginBottom: 'var(--space-2)'}}>{t('dashboard.locksStatus')}</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('dashboard.lockCapacityKey')}</th>
                  <th>{t('label.active')}</th>
                  <th>{t('label.max')}</th>
                  <th>{t('label.queued')}</th>
                  <th>{t('label.owner')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(runtime.locks).map(([key, lock]) => (
                  <tr key={key}>
                    <td style={{fontFamily: 'monospace', fontSize: '0.85em', color: 'var(--color-info)'}}>{key}</td>
                    <td>{lock.capacity || 0}</td>
                    <td>{lock.capacityMax || '-'}</td>
                    <td>{lock.queued || 0}</td>
                    <td style={{fontFamily: 'monospace', fontSize: '0.85em'}}>{lock.ownerId ? lock.ownerId.slice(0, 8) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="surface-card">
        <div className="surface-card-head">
          <h3 style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
            <span style={{width: 4, height: 20, background: 'var(--color-success)', borderRadius: 2, display: 'inline-block'}}></span>
            {t('dashboard.recentRequests')}
          </h3>
        </div>
        
        {logs.length === 0 ? (
          <p className="muted">{t('dashboard.noRequestLogs')}</p>
        ) : (
          <div className="table-wrap">
            <table className="logs-table">
              <thead>
                <tr>
                  <th>{t('label.time')}</th>
                  <th>{t('label.level')}</th>
                  <th>{t('label.path')}</th>
                  <th>{t('label.model')}</th>
                  <th>{t('label.status')}</th>
                </tr>
              </thead>
              <tbody>
                {logs.slice(0, 20).map((log, index) => {
                  const meta = parseLog(log);
                  return (
                    <tr key={`${log.timestamp}-${index}`}>
                      <td style={{color: 'var(--text-secondary)'}}>{new Date(log.timestamp).toLocaleTimeString()}</td>
                      <td><span className={`status-pill status-${log.level === 'error' ? 'dead' : 'alive'}`}>{log.level}</span></td>
                      <td><code style={{color: 'var(--color-accent)'}}>{meta.path || '-'}</code></td>
                      <td>{meta.model || '-'}</td>
                      <td>{meta.status || '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
