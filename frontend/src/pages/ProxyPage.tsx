import React, {useEffect, useMemo, useState} from 'react';
import {useI18n} from '../i18n';

export default function ProxyPage() {
  const {t} = useI18n();
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(8080);
  const [proxyKey, setProxyKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [health, setHealth] = useState<'online' | 'offline' | 'checking'>('checking');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);

  function showToast(msg: string, type: 'success' | 'error' | 'info' = 'success') {
    setToast({ message: msg, type });
  }

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const baseUrl = useMemo(() => `http://${host}:${port}`, [host, port]);

  useEffect(() => {
    loadConfig();
    checkHealth(true);
  }, []);

  async function loadConfig() {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      if (data?.proxy?.host) setHost(data.proxy.host);
      if (data?.proxy?.port) setPort(Number(data.proxy.port));
      setProxyKey(String(data?.proxy?.key || ''));
    } catch {
      // ignore initial load errors
    }
  }

  async function saveProxyConfig() {
    setSaving(true);
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({proxy: {host, port, key: proxyKey}}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      showToast(t('proxy.saved'), 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : t('proxy.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }

  function generateRandomKey() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = 'sk_';
    for (let i = 0; i < 25; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setProxyKey(result);
    showToast(t('proxy.generateKeySuccess'), 'success');
  }

  function copyToClipboard() {
    if (!proxyKey) return;
    navigator.clipboard.writeText(proxyKey)
      .then(() => {
        showToast(t('proxy.copied'), 'success');
      })
      .catch(() => {
        showToast(t('proxy.copyFailed'), 'error');
      });
  }

  async function checkHealth(silent = false) {
    setHealth('checking');
    try {
      const res = await fetch('/health');
      if (res.ok) {
        setHealth('online');
        if (!silent) showToast(t('proxy.online'), 'success');
      } else {
        setHealth('offline');
        if (!silent) showToast(t('proxy.offline'), 'error');
      }
    } catch {
      setHealth('offline');
      if (!silent) showToast(t('proxy.offline'), 'error');
    }
  }

  return (
    <section aria-labelledby="proxy-title" className="page-panel proxy-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('proxy.eyebrow')}</p>
          <h2 id="proxy-title">{t('nav.proxy')}</h2>
        </div>
        <span className={`status-pill status-${health === 'online' ? 'alive' : health === 'offline' ? 'dead' : 'warn'}`}>
          {health === 'online' ? t('proxy.online') : health === 'offline' ? t('proxy.offline') : t('dashboard.checking')}
        </span>
      </div>

      <div className="form-container">
        <form className="surface-card form-grid" onSubmit={(e) => e.preventDefault()} aria-label="Proxy config">
          <label className="field">
            <span>{t('label.host')}</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
          <label className="field">
            <span>{t('label.port')}</span>
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} min={1} max={65535} />
          </label>
          <label className="field field-wide">
            <span>{t('proxy.key')}</span>
            <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
              <input
                type="password"
                value={proxyKey}
                onChange={(e) => setProxyKey(e.target.value)}
                placeholder={t('proxy.keyPlaceholder')}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn secondary"
                onClick={generateRandomKey}
                title={t('proxy.generateKey')}
                style={{ padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '38px', minWidth: '38px' }}
                aria-label={t('proxy.generateKey')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={copyToClipboard}
                title={t('common.copy')}
                style={{ padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '38px', minWidth: '38px' }}
                aria-label={t('common.copy')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                </svg>
              </button>
            </div>
          </label>
          <div className="btn-group field-wide">
            <button type="button" onClick={saveProxyConfig} disabled={saving}>{saving ? t('common.saving') : t('proxy.save')}</button>
            <button type="button" onClick={() => checkHealth(false)} className="secondary">{t('proxy.checkHealth')}</button>
          </div>
        </form>

        <div className="surface-card endpoint-card">
          <h3>{t('proxy.connection')}</h3>
          <p className="muted">{t('label.baseUrl')}: <code>{baseUrl}</code></p>
          <p className="muted">{t('proxy.endpoint')}: <code>{baseUrl}/v1/chat/completions</code></p>
          <p className="muted">{t('proxy.authHeader')}: <code>Authorization: Bearer &lt;proxy-key&gt;</code> {t('proxy.authHeaderHint')} <code>X-Proxy-Key</code></p>
        </div>
        {toast && (
          <div className={`toast-popup ${toast.type}`} role="status">
            {toast.type === 'success' && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
            {toast.type === 'error' && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            )}
            {toast.type === 'info' && (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}>
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="16" x2="12" y2="12" />
                <line x1="12" y1="8" x2="12.01" y2="8" />
              </svg>
            )}
            <span>{toast.message}</span>
          </div>
        )}
      </div>
    </section>
  );
}
