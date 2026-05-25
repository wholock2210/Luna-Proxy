import React, {useEffect, useState} from 'react';
import {Language, useI18n} from '../i18n';

export default function Settings() {
  const {language, setLanguage, t} = useI18n();
  const [overflowEnabled, setOverflowEnabled] = useState(true);
  const [threshold, setThreshold] = useState(10000);
  const [sessionEnabled, setSessionEnabled] = useState(true);
  const [requireExplicitId, setRequireExplicitId] = useState(true);
  const [fileBackedEnabled, setFileBackedEnabled] = useState(true);
  const [createOnOverflow, setCreateOnOverflow] = useState(true);
  const [fallbackMode, setFallbackMode] = useState('stateless');
  const [historyLimit, setHistoryLimit] = useState(10);
  const [autoCompact, setAutoCompact] = useState(true);
  const [compactAfterMessages, setCompactAfterMessages] = useState(40);
  const [compactKeepRecent, setCompactKeepRecent] = useState(5);
  const [compactModel, setCompactModel] = useState('Qwen3.6-Plus');
  const [mtEnabled, setMtEnabled] = useState(true);
  const [globalMaxConcurrent, setGlobalMaxConcurrent] = useState(20);
  const [providerMaxConcurrent, setProviderMaxConcurrent] = useState(5);
  const [accountMaxConcurrent, setAccountMaxConcurrent] = useState(2);
  const [queueTimeoutMs, setQueueTimeoutMs] = useState(120000);
  const [runTimeoutMs, setRunTimeoutMs] = useState(300000);
  const [egressEnabled, setEgressEnabled] = useState(false);
  const [egressStrict, setEgressStrict] = useState(true);
  const [egressFallback, setEgressFallback] = useState(false);
  const [egressVerify, setEgressVerify] = useState(true);
  const [directIp, setDirectIp] = useState('');
  const [directIpSource, setDirectIpSource] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      const ui = data?.settings?.ui || {};
      if (ui.language === 'vi' || ui.language === 'en') setLanguage(ui.language);
      const toc = data?.settings?.tokenOverflow || {};
      setOverflowEnabled(toc.enabled !== false);
      setThreshold(Number(toc.threshold || 10000));
      const ssc = data?.settings?.session || {};
      setSessionEnabled(ssc.enabled !== false);
      setRequireExplicitId(ssc.requireExplicitId !== false);
      setFallbackMode(ssc.fallbackMode || 'file-backed');
      const fbc = ssc.fileBacked || {};
      setFileBackedEnabled(fbc.enabled !== false);
      setCreateOnOverflow(fbc.createOnOverflow !== false);
      setHistoryLimit(Number(ssc.historyLimit || 10));
      setAutoCompact(ssc.autoCompact !== false);
      setCompactAfterMessages(Number(ssc.compactAfterMessages || 40));
      setCompactKeepRecent(Number(ssc.compactKeepRecent || 5));
      setCompactModel(ssc.compactModel || 'Qwen3.6-Plus');
      const mt = data?.settings?.multiThread || {};
      setMtEnabled(mt.enabled !== false);
      setGlobalMaxConcurrent(Number(mt.globalMaxConcurrentRuns || 20));
      setProviderMaxConcurrent(Number(mt.defaultProviderMaxConcurrentRuns || 5));
      setAccountMaxConcurrent(Number(mt.defaultAccountMaxConcurrentRuns || 2));
      setQueueTimeoutMs(Number(mt.queueTimeoutMs || 120000));
      setRunTimeoutMs(Number(mt.runTimeoutMs || 300000));
      const ei = data?.settings?.egressIsolation || {};
      setEgressEnabled(!!ei.enabled);
      setEgressStrict(ei.strict !== false);
      setEgressFallback(!!ei.fallbackToDirect);
      setEgressVerify(ei.verifyBeforeUse !== false);
    } catch {}
    try {
      const ipRes = await fetch('/api/egress/direct-ip');
      const ipData = await ipRes.json();
      setDirectIp(ipData.ip || 'unknown');
      setDirectIpSource(ipData.source || 'unknown');
    } catch {}
  }

  async function saveSettings() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          settings: {
            ui: {
              language,
            },
            tokenOverflow: {
              enabled: overflowEnabled,
              threshold: Number(threshold) || 10000,
            },
            session: {
              enabled: sessionEnabled,
              requireExplicitId,
              fileBacked: {
                enabled: fileBackedEnabled,
                createOnOverflow,
              },
              fallbackMode,
              historyLimit: Number(historyLimit) || 10,
              autoCompact,
              compactAfterMessages: Number(compactAfterMessages) || 40,
              compactKeepRecent: Number(compactKeepRecent) || 5,
              compactModel: compactModel || 'Qwen3.6-Plus',
            },
            multiThread: {
              enabled: mtEnabled,
              globalMaxConcurrentRuns: Number(globalMaxConcurrent) || 20,
              defaultProviderMaxConcurrentRuns: Number(providerMaxConcurrent) || 5,
              defaultAccountMaxConcurrentRuns: Number(accountMaxConcurrent) || 2,
              queueTimeoutMs: Number(queueTimeoutMs) || 120000,
              runTimeoutMs: Number(runTimeoutMs) || 300000,
            },
            egressIsolation: {
              enabled: egressEnabled,
              strict: egressStrict,
              fallbackToDirect: egressFallback,
              verifyBeforeUse: egressVerify,
            },
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMessage(t('settings.saved'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('common.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-labelledby="settings-title" className="page-panel settings-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('settings.eyebrow')}</p>
          <h2 id="settings-title">{t('settings.title')}</h2>
        </div>
      </div>

      <div className="form-container">
        <div className="surface-card" style={{marginBottom: 16}}>
          <h3>{t('settings.ui.title')}</h3>
          <div className="settings-grid">
            <label className="field">
              <span>{t('settings.ui.language')}</span>
              <select value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
                <option value="en">{t('settings.ui.english')}</option>
                <option value="vi">{t('settings.ui.vietnamese')}</option>
              </select>
              <p className="field-hint" style={{marginTop: 4, fontSize: '0.85em', color: 'var(--color-text-secondary)'}}>
                {t('settings.ui.languageHint')}
              </p>
            </label>
          </div>
        </div>

        <div className="surface-card" style={{marginBottom: 16}}>
          <h3>{t('settings.tokenOverflow.title')}</h3>
          <div className="settings-grid">
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={overflowEnabled}
                onChange={(e) => setOverflowEnabled(e.target.checked)}
              />
              <span>{t('settings.tokenOverflow.enableRawFile')}</span>
            </label>
            <label className="field">
              <span>{t('settings.tokenOverflow.threshold')}</span>
              <input
                type="number"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                min={1000}
                step={500}
              />
            </label>
          </div>
        </div>

        <div className="surface-card" style={{marginBottom: 16}}>
          <h3>{t('settings.session.title')}</h3>
          <div className="settings-grid">
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={sessionEnabled}
                onChange={(e) => setSessionEnabled(e.target.checked)}
              />
              <span>{t('settings.session.enable')}</span>
            </label>
            <label className="field">
              <span>{t('settings.session.historyLimit')}</span>
              <select value={historyLimit} onChange={(e) => setHistoryLimit(Number(e.target.value))}>
                <option value={1}>1</option>
                <option value={5}>5</option>
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={50}>50</option>
              </select>
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={autoCompact}
                onChange={(e) => setAutoCompact(e.target.checked)}
              />
              <span>{t('settings.session.autoCompact')}</span>
            </label>
            <label className="field">
              <span>{t('settings.session.compactAfter')}</span>
              <input
                type="number"
                value={compactAfterMessages}
                onChange={(e) => setCompactAfterMessages(Number(e.target.value))}
                min={10}
                step={5}
              />
            </label>
            <label className="field">
              <span>{t('settings.session.keepRecent')}</span>
              <input
                type="number"
                value={compactKeepRecent}
                onChange={(e) => setCompactKeepRecent(Number(e.target.value))}
                min={1}
                max={20}
              />
            </label>
            <label className="field">
              <span>{t('settings.session.compactModel')}</span>
              <input
                value={compactModel}
                onChange={(e) => setCompactModel(e.target.value)}
              />
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={requireExplicitId}
                onChange={(e) => setRequireExplicitId(e.target.checked)}
              />
              <span>{t('settings.session.requireExplicitId')}</span>
            </label>
            <label className="toggle-field">
              <input type="checkbox" checked={fileBackedEnabled} onChange={(e) => setFileBackedEnabled(e.target.checked)} />
              <span>{t('settings.session.fileBacked')}</span>
            </label>
            <label className="toggle-field">
              <input type="checkbox" checked={createOnOverflow} onChange={(e) => setCreateOnOverflow(e.target.checked)} />
              <span>{t('settings.session.createOnOverflow')}</span>
            </label>
            <label className="field">
              <span>{t('settings.session.fallbackMode')}</span>
              <div>
                <select value={fallbackMode} onChange={(e) => setFallbackMode(e.target.value)}>
                  <option value="file-backed">{t('settings.session.fileBackedOption')}</option>
                  <option value="stateless">{t('settings.session.statelessOption')}</option>
                  <option value="transient">{t('settings.session.transientOption')}</option>
                  <option value="shared-default">{t('settings.session.sharedDefaultOption')}</option>
                </select>
                <p className="field-hint" style={{marginTop: 4, fontSize: '0.85em', color: 'var(--color-text-secondary)'}}>
                  {fallbackMode === 'file-backed'
                    ? t('settings.session.fileBackedHint')
                    : fallbackMode === 'stateless'
                      ? t('settings.session.statelessHint')
                      : fallbackMode === 'transient'
                        ? t('settings.session.transientHint')
                        : t('settings.session.sharedDefaultHint')}
                </p>
              </div>
            </label>
          </div>
        </div>

        <div className="surface-card" style={{marginBottom: 16}}>
          <h3>{t('settings.multiThread.title')}</h3>
          <div className="settings-grid">
            <label className="toggle-field">
              <input type="checkbox" checked={mtEnabled} onChange={(e) => setMtEnabled(e.target.checked)} />
              <span>{t('settings.multiThread.enable')}</span>
            </label>
            <label className="field">
              <span>{t('settings.multiThread.globalMax')}</span>
              <input type="number" value={globalMaxConcurrent} onChange={(e) => setGlobalMaxConcurrent(Number(e.target.value))} min={1} />
            </label>
            <label className="field">
              <span>{t('settings.multiThread.providerMax')}</span>
              <input type="number" value={providerMaxConcurrent} onChange={(e) => setProviderMaxConcurrent(Number(e.target.value))} min={1} />
            </label>
            <label className="field">
              <span>{t('settings.multiThread.accountMax')}</span>
              <input type="number" value={accountMaxConcurrent} onChange={(e) => setAccountMaxConcurrent(Number(e.target.value))} min={1} />
            </label>
            <label className="field">
              <span>{t('settings.multiThread.queueTimeout')}</span>
              <input type="number" value={queueTimeoutMs} onChange={(e) => setQueueTimeoutMs(Number(e.target.value))} min={5000} step={5000} />
            </label>
            <label className="field">
              <span>{t('settings.multiThread.runTimeout')}</span>
              <input type="number" value={runTimeoutMs} onChange={(e) => setRunTimeoutMs(Number(e.target.value))} min={10000} step={10000} />
            </label>
          </div>
        </div>

        <div className="surface-card" style={{marginBottom: 16}}>
          <h3>{t('settings.egress.title')}</h3>
          <div className="settings-grid">
            <label className="toggle-field">
              <input type="checkbox" checked={egressEnabled} onChange={(e) => setEgressEnabled(e.target.checked)} />
              <span>{t('settings.egress.enable')}</span>
            </label>
            {egressEnabled && (
              <>
                <label className="toggle-field">
                  <input type="checkbox" checked={egressStrict} onChange={(e) => setEgressStrict(e.target.checked)} />
                  <span>{t('settings.egress.strict')}</span>
                </label>
                <label className="toggle-field">
                  <input type="checkbox" checked={egressFallback} onChange={(e) => setEgressFallback(e.target.checked)} />
                  <span>{t('settings.egress.fallback')}</span>
                </label>
                <label className="toggle-field">
                  <input type="checkbox" checked={egressVerify} onChange={(e) => setEgressVerify(e.target.checked)} />
                  <span>{t('settings.egress.verify')}</span>
                </label>
              </>
            )}
          </div>
          <div className="detail-grid" style={{marginTop: 12}}>
            <dt>{t('settings.egress.directIp')}</dt>
            <dd>{directIp || t('settings.egress.checking')} <span className="muted">({directIpSource})</span></dd>
          </div>
          {egressEnabled && (
            <p style={{marginTop: 8, fontSize: '0.85em', padding: '8px 12px', background: 'var(--color-warning-bg)', borderRadius: 4}}>
              {t('settings.egress.warning')}
            </p>
          )}
        </div>

        <div className="btn-group">
          <button onClick={saveSettings} disabled={saving}>
            {saving ? t('common.saving') : t('settings.save')}
          </button>
        </div>
        {message ? <p className="muted" style={{ marginTop: 12 }}>{message}</p> : null}
      </div>
    </section>
  );
}
