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
  const [isEditing, setIsEditing] = useState(false);

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

  const [rawJsonInput, setRawJsonInput] = useState('');
  const [emailValue, setEmailValue] = useState('');

  function openAdd() {
    const bp = builtinProviders[0];
    setSelected(bp);
    setTokenValue('');
    setCookieValue('');
    setRawJsonInput('');
    setEmailValue('');
    setActiveTab('config');
    setValidation(null);
    setIsEditing(false);
    setShowAdd(true);
  }

  function openEditorForProvider(p: ProviderConfig) {
    const built = builtinProviders.find(b => b.id === p.id) || {id: p.id, name: p.name || p.id, loginUrl: 'https://chat.qwen.ai'};
    setSelected(built);
    setTokenValue(p.credentials?.token || '');
    setCookieValue((p.credentials?.cookies || p.credentials?.cookie || ''));
    setRawJsonInput('');
    setEmailValue(p.name || '');
    setActiveTab('config');
    setValidation(null);
    setIsEditing(true);
    setShowAdd(true);
  }

  function closeAdd() {
    setShowAdd(false);
  }

  function handleJsonChange(val: string) {
    setRawJsonInput(val);
    if (!val.trim()) return;
    try {
      const parsed = JSON.parse(val.trim());
      if (parsed && parsed.token) {
        setTokenValue(parsed.token);
        setEmailValue(parsed.email || parsed.name || 'Qwen Account');
        setValidation(null);
      } else {
        setValidation({ text: 'JSON hợp lệ nhưng không tìm thấy trường "token".', type: 'error' });
      }
    } catch {
      // Đang dán JSON chưa hoàn thành, bỏ qua báo lỗi tạm thời
    }
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
    
    let token = tokenValue;
    if (rawJsonInput && !token) {
      try {
        const parsed = JSON.parse(rawJsonInput.trim());
        if (parsed.token) {
          token = parsed.token;
          setTokenValue(token);
          setEmailValue(parsed.email || parsed.name || 'Qwen Account');
        }
      } catch (err) {
        setValidation({ text: 'JSON không hợp lệ. Vui lòng kiểm tra lại.', type: 'error' });
        return;
      }
    }

    if (!token || token.trim().length === 0) {
      setValidation({ text: 'Vui lòng dán JSON chứa token hợp lệ.', type: 'error' });
      return;
    }

    const creds = { token: token.trim() };

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
    let token = tokenValue;
    let email = emailValue;

    if (rawJsonInput) {
      try {
        const parsed = JSON.parse(rawJsonInput.trim());
        if (parsed.token) {
          token = parsed.token;
          email = parsed.email || parsed.name || 'Qwen Account';
        }
      } catch {
        setValidation({ text: 'JSON không hợp lệ. Vui lòng kiểm tra lại.', type: 'error' });
        return;
      }
    }

    if (!token || token.trim().length === 0) {
      setValidation({ text: 'Vui lòng dán JSON chứa token hợp lệ.', type: 'error' });
      return;
    }

    try {
      const credentials = { token: token.trim() };
      const res = await fetch('/api/provider/token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          providerId: selected.id,
          credentials,
          name: email
        }),
      });
      if (res.ok) {
        await loadConfig();
        setShowAdd(false);
      } else {
        setValidation({ text: 'Lưu cấu hình thất bại.', type: 'error' });
      }
    } catch (err) {
      console.error('save failed', err);
      setValidation({ text: 'Lỗi kết nối khi lưu cấu hình.', type: 'error' });
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
              <h3 id="modal-title" style={{ fontSize: '1.25rem' }}>
                {isEditing ? t('providers.editAccount') : t('providers.add')}
              </h3>
              <button aria-label={t('common.close')} className="modal-close-btn" onClick={closeAdd}>×</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
              {isEditing ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  <label className="field">
                    <span>{t('providers.displayName')}</span>
                    <input
                      type="text"
                      value={emailValue}
                      onChange={(e) => setEmailValue(e.target.value)}
                      placeholder="lole7176@gmail.com"
                    />
                  </label>
                  <label className="field">
                    <span>{t('providers.sessionTokenJson')}</span>
                    <textarea
                      value={rawJsonInput}
                      onChange={(e) => handleJsonChange(e.target.value)}
                      style={{ height: '120px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
                      placeholder={t('providers.sessionTokenPlaceholder')}
                    />
                  </label>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
                  <div>
                    <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>{t('providers.step1')}</strong>
                    <button className="btn secondary" onClick={() => window.open('https://chat.qwen.ai/auth', '_blank')}>
                      {t('providers.goToLogin')}
                    </button>
                  </div>

                  <div>
                    <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>{t('providers.step2')}</strong>
                    <button className="btn secondary" onClick={() => window.open('https://chat.qwen.ai/api/v1/auths/', '_blank')}>
                      {t('providers.goToApi')}
                    </button>
                  </div>

                  <div className="field">
                    <strong style={{ display: 'block', marginBottom: 'var(--space-2)' }}>{t('providers.step3')}</strong>
                    <textarea
                      value={rawJsonInput}
                      onChange={(e) => handleJsonChange(e.target.value)}
                      style={{ height: '120px', resize: 'vertical', fontFamily: 'monospace', fontSize: '0.85rem' }}
                      placeholder={t('providers.jsonPlaceholder')}
                    />
                  </div>
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
