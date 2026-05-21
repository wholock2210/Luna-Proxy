import React, {useCallback, useEffect, useState} from 'react';

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
      setMessage(error instanceof Error ? error.message : 'Failed to load models');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  async function refreshModels() {
    setRefreshing(true);
    setMessage('Refreshing from built-in Qwen catalog...');
    try {
      const res = await fetch('/api/models/refresh', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setMessage(data?.error || 'Failed to refresh models');
        return;
      }
      setMessage(`Loaded ${data.count} models from built-in Qwen catalog`);
      await loadModels();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Failed to refresh models');
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <section aria-labelledby="models-title" className="page-panel models-panel">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Provider catalog</p>
          <h2 id="models-title">Models</h2>
        </div>
        <span className="status-pill status-alive">{models.length} models</span>
      </div>

      <div className="surface-card">
        <p className="muted">Provider: Qwen AI (International). Source: built-in catalog.</p>
        <div className="action-row">
        <button onClick={refreshModels} disabled={refreshing || loading}>
          {refreshing ? 'Refreshing...' : 'Refresh catalog'}
        </button>
        {updatedAt ? <span className="muted">Updated: {new Date(updatedAt).toLocaleString()}</span> : null}
        </div>
      </div>
      {message ? <p className="muted">{message}</p> : null}
      {loading ? <p className="muted">Loading models...</p> : null}
      {!loading && models.length === 0 ? <p className="muted">No models loaded yet.</p> : null}

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
            {m.maxContextLength ? <div className="model-meta muted">Context: {m.maxContextLength}</div> : null}
          </li>
        ))}
      </ul>

      {selectedModel ? (
        <div className="detail-overlay" role="dialog" aria-modal="true" aria-labelledby="model-detail-title">
          <aside className="detail-panel">
            <button className="modal-close-btn" aria-label="Close model detail" onClick={() => setSelectedModel(null)}>×</button>
            <div className="detail-heading">
              <p className="eyebrow">Model detail</p>
              <h3 id="model-detail-title">{selectedModel.name}</h3>
              <p className="muted">{selectedModel.id}</p>
            </div>

            <div className="detail-content" style={{marginTop: 16}}>
              {selectedModel.description ? <p style={{marginTop: 0}}>{selectedModel.description}</p> : null}
              <dl className="detail-grid">
                <dt>Maximum context length</dt><dd>{selectedModel.maxContextLength || '-'}</dd>
                <dt>Max summary generation length</dt><dd>{selectedModel.maxSummaryGenerationLength || '-'}</dd>
                <dt>Maximum generation length</dt><dd>{selectedModel.maxGenerationLength || '-'}</dd>
                <dt>Max thinking generation length</dt><dd>{selectedModel.maxThinkingGenerationLength || '-'}</dd>
                <dt>Modality</dt><dd>{selectedModel.modality?.join(', ') || '-'}</dd>
              </dl>
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}
