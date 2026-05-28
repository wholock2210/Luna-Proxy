import React, {useCallback, useEffect, useState} from 'react';
import {useI18n} from '../i18n';

type ModelItem = {
  id: string;
  name: string;
  description?: string;
  maxContextLength?: string;
  maxSummaryGenerationLength?: string;
  maxGenerationLength?: string;
  maxThinkingGenerationLength?: string;
  modality?: string[];
};

export default function Models() {
  const {t} = useI18n();
  const [models, setModels] = useState<ModelItem[]>([]);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState<ModelItem | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      setModels(items);
      setUpdatedAt(data?.updatedAt || null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('models.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  async function refreshModels() {
    setRefreshing(true);
    setMessage(t('models.refreshingCatalog'));
    try {
      const res = await fetch('/api/models/refresh', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(data?.error || t('models.refreshFailed'));
        return;
      }
      setMessage(t('models.loadedCatalog', {count: data.count}));
      await loadModels();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t('models.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section aria-labelledby="models-title" className="page-panel models-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('models.eyebrow')}</p>
          <h2 id="models-title">{t('nav.models')}</h2>
        </div>
        <span className="status-pill status-alive">{t('models.count', {count: models.length})}</span>
      </div>

      <div className="surface-card">
        <p className="muted">{t('models.providerSource')}</p>
        <div className="btn-group">
          <button onClick={refreshModels} disabled={refreshing || loading}>
            {refreshing ? t('models.refreshing') : t('models.refreshCatalog')}
          </button>
          {updatedAt ? <span className="muted" style={{ marginLeft: 'var(--space-2)' }}>{t('common.updated')}: {new Date(updatedAt).toLocaleString()}</span> : null}
        </div>
      </div>
      {message ? <p className="muted">{message}</p> : null}
      {loading ? <p className="muted">{t('models.loading')}</p> : null}
      {!loading && models.length === 0 ? <p className="muted">{t('models.empty')}</p> : null}

      <ul className="model-grid">
        {models.map((m) => (
          <li
            key={m.id}
            className="model-item clickable-row"
            tabIndex={0}
            onClick={() => setSelectedModel(m)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') setSelectedModel(m);
            }}
          >
            <div className="model-name">{m.name}</div>
            <div className="model-meta muted">{m.id}</div>
            {m.maxContextLength ? <div className="model-meta muted">{t('models.context')}: {m.maxContextLength}</div> : null}
          </li>
        ))}
      </ul>

      {selectedModel ? (
        <div className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="model-detail-title" onClick={() => setSelectedModel(null)}>
          <aside className="detail-panel" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close-btn" aria-label={t('common.close')} onClick={() => setSelectedModel(null)}>×</button>
            <div className="detail-heading">
              <p className="eyebrow">{t('models.detail')}</p>
              <h3 id="model-detail-title">{selectedModel.name}</h3>
              <p className="muted">{selectedModel.id}</p>
            </div>

            <div className="detail-content" style={{marginTop: 16}}>
              {selectedModel.description ? <p style={{marginTop: 0}}>{selectedModel.description}</p> : null}
              <dl className="detail-grid">
                <dt>{t('models.maxContext')}</dt><dd>{selectedModel.maxContextLength || '-'}</dd>
                <dt>{t('models.maxSummary')}</dt><dd>{selectedModel.maxSummaryGenerationLength || '-'}</dd>
                <dt>{t('models.maxGeneration')}</dt><dd>{selectedModel.maxGenerationLength || '-'}</dd>
                <dt>{t('models.maxThinking')}</dt><dd>{selectedModel.maxThinkingGenerationLength || '-'}</dd>
                <dt>{t('models.modality')}</dt><dd>{selectedModel.modality?.join(', ') || '-'}</dd>
              </dl>
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
// test watcher
