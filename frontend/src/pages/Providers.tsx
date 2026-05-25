import React, {useEffect, useState} from 'react';
import {useI18n} from '../i18n';

type ProviderConfig = { id: string; name?: string; credentials?: Record<string,string>; oauth?: any };
type ProviderStatus = 'alive' | 'warn' | 'dead';

const builtinProviders = [
  { id: 'qwen-ai', name: 'Qwen AI (International)', loginUrl: 'https://chat.qwen.ai' },
];

export default function Providers() {
  const {t} = useI18n();
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selected, setSelected] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<'config'|'oauth'>('config');
  const [tokenValue, setTokenValue] = useState('');
  const [cookieValue, setCookieValue] = useState('');
  const [validation, setValidation] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
  const [oauthPolling, setOauthPolling] = useState(false);
  const [oauthConfig, setOauthConfig] = useState<any>(null);
  const [providerStatus, setProviderStatus] = useState<Record<string, ProviderStatus>>({});

  useEffect(() => { loadConfig(); }, []);

  async function loadConfig() {
    setLoading(true);
    try {
      const res = await fetch('/api/config');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const items = data.providers || [];
      setProviders(items);
      await Promise.all(
        items.map(async (p: ProviderConfig) => {
          try {
            const s = await fetch(`/api/provider/status?providerId=${encodeURIComponent(p.id)}`);
            const d = await s.json();
            if (d?.status) {
              setProviderStatus(prev => ({...prev, [p.id]: d.status as ProviderStatus}));
            }
          } catch {
            setProviderStatus(prev => ({...prev, [p.id]: 'warn'}));
          }
        }),
      );
    } catch (err) {
      console.error('Failed to load config', err);
      setProviders([]);
    } finally {
      setLoading(false);
    }
  }

  const configured = providers.filter(p => p.credentials && Object.keys(p.credentials).length > 0);

  function openAdd() {
    setSelected(null);
    setTokenValue('');
    setCookieValue('');
    setActiveTab('config');
    setValidation(null);
    setShowAdd(true);
  }

  function openEditorForProvider(p: ProviderConfig) {
    const built = builtinProviders.find(b => b.id === p.id) || {id: p.id, name: p.name || p.id, loginUrl: 'https://chat.qwen.ai'};
    setSelected(built);
    setTokenValue(p.credentials?.token || '');
    setCookieValue((p.credentials?.cookies || p.credentials?.cookie || ''));
    setActiveTab('config');
    setValidation(null);
    setShowAdd(true);
  }

  function closeAdd() {
    setShowAdd(false);
  }

  function pickBuiltin(p: any) {
    setSelected(p);
    setActiveTab('config');
    setTokenValue('');
    setCookieValue('');
    setValidation(null);
  }

  async function loadOauthConfig(providerId: string) {
    try {
      const resp = await fetch(`/api/provider/oauth-config?providerId=${encodeURIComponent(providerId)}`);
      if (!resp.ok) {
        setOauthConfig(null);
        return;
      }
      const data = await resp.json();
      setOauthConfig(data || null);
    } catch (err) {
      console.error('loadOauthConfig failed', err);
      setOauthConfig(null);
    }
  }

  function openLoginAndSwitch() {
    if (!selected) return;
    window.open(selected.loginUrl || 'https://chat.qwen.ai', '_blank');
    setActiveTab('config');
  }

  async function startOAuth() {
    if (!selected) return;
    setValidation(null);
    setOauthPolling(true);
    try {
      setValidation({ text: t('providers.oauthOpening'), type: 'info' });
      const resp = await fetch('/api/provider/oauth/capture', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({providerId: selected.id, timeout: 300000}),
      });
      const data = await resp.json();
      if (!resp.ok || !data.success) {
        setValidation({ text: data.error || t('providers.oauthFailed'), type: 'error' });
        return;
      }

      const creds = data.credentials || {};
      if (creds.token) setTokenValue(creds.token);
      if (creds.cookies) setCookieValue(creds.cookies);
      await loadConfig();
      setValidation({ text: t('providers.oauthCaptured'), type: 'success' });
    } catch (err) {
      console.error('startOAuth failed', err);
      setValidation({ text: err instanceof Error ? err.message : t('providers.oauthStartFailed'), type: 'error' });
    } finally {
      setOauthPolling(false);
    }
  }

  async function validate() {
    if (!selected) return;
    setValidation({ text: t('providers.checking'), type: 'info' });
    const creds: any = {};
    const tokenKey = selected.id === 'qwen-ai' ? 'token' : 'ticket';
    const cookieKey = selected.id === 'qwen-ai' ? 'cookies' : 'cookie';

    if (tokenValue && tokenValue.trim().length > 0) {
      creds[tokenKey] = tokenValue.trim();
    }
    if (cookieValue && cookieValue.trim().length > 0) {
      creds[cookieKey] = cookieValue.trim();
    }
    if (Object.keys(creds).length === 0) {
      setValidation({ text: activeTab === 'oauth' ? t('providers.startFirst') : t('providers.provideCredential'), type: 'error' });
      return;
    }

    try {
      const resp = await fetch('/api/provider/validate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: selected.id, credentials: creds }),
      });
      const data = await resp.json();
      if (data && data.ok) setValidation({ text: t('providers.valid'), type: 'success' });
      else setValidation({ text: t('providers.invalid'), type: 'error' });
    } catch (err) {
      console.error(err);
      setValidation({ text: t('providers.validationFailed'), type: 'error' });
    }
  }

  async function save() {
    if (!selected) return;
    try {
      const tokenKey = selected.id === 'qwen-ai' ? 'token' : 'ticket';
      const cookieKey = selected.id === 'qwen-ai' ? 'cookies' : 'cookie';

      const credentials: Record<string, string> = {};
      if (tokenValue && tokenValue.trim().length > 0) {
        credentials[tokenKey] = tokenValue.trim();
      }
      if (cookieValue && cookieValue.trim().length > 0) {
        credentials[cookieKey] = cookieValue.trim();
      }

      if (Object.keys(credentials).length > 0) {
        await fetch('/api/provider/token', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({providerId: selected.id, credentials}),
        });
      } else {
        setValidation({ text: activeTab === 'oauth' ? t('providers.startFirst') : t('providers.nothingToSave'), type: 'error' });
        return;
      }
      await loadConfig();
      setShowAdd(false);
    } catch (err) {
      console.error('save failed', err);
    }
  }

  return (
    <div className="page-panel">
      <div className="page-heading">
        <h2 id="providers-title">{t('nav.providers')}</h2>
        <button className="btn" onClick={openAdd}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
          {t('providers.add')}
        </button>
      </div>

      <div className="providers-wrapper">
        {loading ? (
          <div className="muted">{t('common.loading')}</div>
        ) : configured.length === 0 ? (
          <div className="muted">{t('providers.empty')}</div>
        ) : (
          configured.map(p => (
            <div key={p.id} className="surface-card provider-card" onClick={() => openEditorForProvider(p)}>
              <div className="provider-card-head">
                <h3 className="provider-name">{p.name || p.id}</h3>
                <span className={`provider-status-dot status-${providerStatus[p.id] || 'warn'}`} />
              </div>
              <p className="provider-credentials">
                {p.credentials ? Object.keys(p.credentials).map(k => `${k}: ${String(p.credentials![k]).slice(0,8)}...`).join(' • ') : ''}
              </p>
            </div>
          ))
        )}
      </div>

      {showAdd && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div className="modal-panel">
            <div className="surface-card-head" style={{ marginBottom: 'var(--space-4)' }}>
              <h3 id="modal-title" style={{ fontSize: '1.25rem' }}>{selected ? selected.name : t('providers.add')}</h3>
              <button aria-label={t('common.close')} className="modal-close-btn" onClick={closeAdd}>×</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {!selected ? (
                <div>
                  <label className="muted" style={{ display: 'block', marginBottom: 'var(--space-2)' }}>{t('providers.available')}</label>
                  <div className="btn-group" style={{ flexWrap: 'wrap' }}>
                    {builtinProviders.map(bp => (
                      <button key={bp.id} className="btn secondary" onClick={() => pickBuiltin(bp)}>
                        {bp.name}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="btn-group" style={{ borderBottom: '1px solid var(--border-strong)', paddingBottom: 'var(--space-3)' }}>
                    <button className={`btn ${activeTab === 'config' ? '' : 'secondary'}`} onClick={() => setActiveTab('config')}>
                      {t('providers.config')}
                    </button>
                    <button className={`btn ${activeTab === 'oauth' ? '' : 'secondary'}`} onClick={() => setActiveTab('oauth')}>
                      OAuth
                    </button>
                  </div>

                  {activeTab === 'config' ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
                      <div className="field">
                        <label>{t('providers.token')}</label>
                        <input value={tokenValue} onChange={(e) => setTokenValue(e.target.value)} placeholder="Nhập token tại đây..." />
                        <span className="muted" style={{ fontSize: '0.8rem' }}>{t('providers.tokenHint')}</span>
                      </div>
                      <div className="field">
                        <label>{t('providers.cookie')}</label>
                        <textarea value={cookieValue} onChange={(e)=>setCookieValue(e.target.value)} style={{ height: '80px', resize: 'vertical' }} placeholder="Nhập cookie thô tại đây..." />
                      </div>
                      <div className="btn-group" style={{ marginTop: 'var(--space-2)' }}>
                        <button className="btn secondary" onClick={openLoginAndSwitch}>{t('providers.openLogin')}</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', alignItems: 'center', textAlign: 'center' }}>
                      <p className="muted">{t('providers.oauthHint')}</p>
                      <button onClick={startOAuth} disabled={oauthPolling} className="btn">
                        {oauthPolling ? t('providers.waitLogin') : t('providers.startOAuth')}
                      </button>
                      {(tokenValue || cookieValue) && (
                        <div className="surface-card" style={{ width: '100%', textAlign: 'left', marginTop: 'var(--space-3)' }}>
                          {tokenValue && <div className="provider-credentials" style={{ marginBottom: 4 }}>token: {tokenValue.slice(0, 12)}...</div>}
                          {cookieValue && <div className="provider-credentials">cookies: {cookieValue.slice(0, 12)}...</div>}
                        </div>
                      )}
                    </div>
                  )}

                  {validation && (
                    <div className={`validation-box status-${validation.type}`}>
                      <span>{validation.text}</span>
                    </div>
                  )}

                  <div className="btn-group" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
                    <button className="btn secondary" onClick={validate}>{t('providers.validate')}</button>
                    <button className="btn" onClick={save}>{t('providers.save')}</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
