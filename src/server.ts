// @ts-nocheck
import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import {Server as HttpServer} from 'http';
import https from 'https';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import koaStatic from 'koa-static';
import {QwenAiAdapter, QwenAiStreamHandler, buildQwenAiHeaders} from './main/proxy/adapters/qwen-ai';
import {QwenAiAdapter as QwenAiOAuthAdapter} from './main/oauth/adapters/qwen-ai';
import {captureQwenAiCredentials} from './main/oauth/qwenAiCapture';
import {Account, Provider} from './main/store/types';
import {configStore} from './configStore';
import {sessionStore} from './sessionStore';
import type {StoredSession, SessionMessage} from './sessionStore';
import {runStore} from './runtime/runStore';
import {lockManager} from './runtime/locks';
import {scheduleRun, releaseRun, startRunTimeout, getRuntimeDiagnostics, setSchedulerConfig, getSchedulerConfig, acquireSessionWriteLock, releaseSessionWriteLock, acquireProviderBindingLock, releaseProviderBindingLock} from './runtime/scheduler';
import {selectProvider, selectAccount, setRouterConfig, getAccountsFromProviderConf} from './runtime/providerRouter';
import {createAdapter} from './runtime/providerFactory';
import {WorkerClient} from './runtime/workerClient';
import {selectWorker} from './runtime/workerSelector';
import {registerRunController, unregisterRunController, abortRun} from './runtime/runControllers';
import {getNetworkProfiles, upsertNetworkProfile, deleteNetworkProfile, verifyDirectIp} from './runtime/networkProfiles';
import type {RunContext, ProviderBinding, ProviderAccount, ProviderWorker, NetworkProfile} from './runtime/types';
import axios from 'axios';
import * as querystring from 'querystring';
import {qwenAiConfig, getQwenAiModelCatalog, getQwenAiModelMappings} from './main/providers/builtin/qwen-ai';
import {isAssistantFailureEcho, stripThinkingBlocks, messageSimilarity} from './main/proxy/overflowSanitizer';
import {getWorkers, upsertWorker, deleteWorker, verifyWorkerIp} from './modules/workers';
import {analyzeResponseXml} from './modules/responseAnalyzer';
import {extractText, estimateTokens, validateInputSize} from './modules/textUtils';
import {normalizeUpstreamError, formatUpstreamErrorResponse, isRetryableError} from './modules/upstreamErrorHandler';
import {collectNonStreamFromTransformedSSE} from './modules/sseCollector';
import {applyTokenOverflowPolicy} from './modules/overflowPolicy';
import {persistSessionMessages} from './modules/sessionPersistence';
import {compactSession} from './modules/sessionCompactor';
import {computeInboundContextHash, computeOutboundContextHash} from './modules/contextHash';
import {chatCleanupScheduler} from './modules/chatCleanup';
import {uploadOverflowFileToQwen} from './modules/ossUploader';
import {
  convertToInternalRequest,
  estimateAnthropicInputTokens,
  renderAnthropicNonStream,
  createAnthropicStream,
  writeAnthropicStreamText,
  writeAnthropicStreamToolCall,
  endAnthropicStream,
} from './main/proxy/anthropic';
import {getToolNames, parseToolCalls, cleanVisibleText} from './main/proxy/toolcall/toolcall';
import {injectToolPrompt, normalizeToolMessages} from './main/proxy/toolcall/toolcall';
import {
  getAllPrompts,
  getPromptOverrides,
  setPromptOverride,
  resetPromptOverrides,
} from './main/proxy/prompts/prompts';

const SENSITIVE_HEADER_RE = /(authorization|cookie|token|api-key|x-proxy-key|proxy-authorization|secret|session)/i;

function convertOpenAiTools(tools: any[] | undefined): any[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map(tool => {
      if (tool?.type === 'function' && tool.function) {
        return {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters,
        };
      }
      if (tool?.name) {
        return {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters || tool.input_schema,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function convertOpenAiToolChoice(toolChoice: any): any {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') return { mode: 'none' };
    if (toolChoice === 'required') return { mode: 'required' };
    return { mode: 'auto' };
  }
  if (toolChoice?.type === 'function' && toolChoice.function?.name) {
    return { mode: 'specific', name: toolChoice.function.name };
  }
  if (toolChoice?.mode) return toolChoice;
  return { mode: 'auto' };
}

function normalizeOpenAiMessagesForTools(messages: any[]): any[] {
  return (messages || []).map(msg => {
    if (!msg || typeof msg !== 'object') return msg;
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((part: any) => extractText(part)).filter(Boolean).join('\n')
        : extractText(msg.content);
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      return {
        role: 'assistant',
        content: content || '',
        toolCalls: msg.tool_calls.map((tc: any) => ({
          id: tc.id,
          name: tc.function?.name || tc.name,
          input: typeof tc.function?.arguments === 'string'
            ? safeJsonObject(tc.function.arguments)
            : (tc.function?.arguments || tc.input || {}),
        })),
      };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: content || '',
        toolCallId: msg.tool_call_id,
        toolName: msg.name,
      };
    }
    return { ...msg, content: content || '' };
  });
}

function buildQwenMessagesForToolPrompt(messages: any[]): any[] {
  let systemContent = '';
  const nonSystem: any[] = [];
  for (const msg of messages || []) {
    if (msg.role === 'system') {
      systemContent += (systemContent ? '\n\n' : '') + (msg.content || '');
    } else {
      nonSystem.push(msg);
    }
  }

  const chatMessages: any[] = [];
  if (systemContent) chatMessages.push({ role: 'system', content: systemContent });
  if (nonSystem.length > 0) {
    const userContent = nonSystem.length === 1
      ? (nonSystem[0].content || '')
      : nonSystem.map(m => `${m.role}:${m.content || ''}`).join(';');
    chatMessages.push({ role: 'user', content: userContent });
  }
  return chatMessages.length > 0 ? chatMessages : [{ role: 'user', content: 'Hello' }];
}

function safeJsonObject(value: string): Record<string, any> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeHeaders(headers: Record<string, any> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const normalizedKey = String(key).toLowerCase();
    if (Array.isArray(value)) {
      out[normalizedKey] = value.map(v => String(v)).join('; ');
    } else {
      out[normalizedKey] = String(value);
    }
  }
  return out;
}

function maskHeaders(headers: Record<string, any> | undefined | null): Record<string, string> {
  const normalized = normalizeHeaders(headers);
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalized)) {
    masked[key] = SENSITIVE_HEADER_RE.test(key) ? '[redacted]' : value;
  }
  return masked;
}

function getClientResponseHeaders(ctx: Koa.Context): Record<string, string> {
  const headers = maskHeaders(ctx.res.getHeaders() as Record<string, any>);
  const type = ctx.response.type;
  if (type && !headers['content-type']) headers['content-type'] = type;
  return headers;
}

export class SimpleProxyServer {
  private app: Koa;
  private router: Router;
  private server: HttpServer | null = null;

  constructor() {
    this.app = new Koa();
    this.router = new Router();
    this.setupMiddleware();
    this.setupRoutes();
    sessionStore.startCleanupInterval();
    const conf = configStore.getConfig();
    chatCleanupScheduler.start(conf.settings?.session?.chatCleanup || {}, () => {
      const providerConf = configStore.getConfig().providers.find(p => p.id === 'qwen-ai');
      const account = providerConf ? getAccountsFromProviderConf(providerConf)[0] : undefined;
      if (!account) return null;
      return new QwenAiAdapter({
        id: 'qwen-ai',
        apiEndpoint: 'https://chat.qwen.ai',
        chatPath: '/api/v2/chat/completions',
      } as Provider, account);
    });
  }

  private setupMiddleware() {
    this.app.use(async (ctx, next) => {
      ctx.set('Access-Control-Allow-Origin', '*');
      ctx.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      ctx.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (ctx.method === 'OPTIONS') {
        ctx.status = 204;
        return;
      }
      await next();
    });

    // Static UI is served from public/ by koa-static. No dev proxy used.

    this.app.use(
      bodyParser({ jsonLimit: '10mb', formLimit: '10mb', textLimit: '10mb' }),
    );
  }

  private setupRoutes() {
    // serve static frontend (package public directory)
    const publicDir = path.join(__dirname, '..', 'public');
    const frontendIndex = path.join(publicDir, 'index.html');
    console.log('[SimpleProxyServer] serving static from', publicDir);
    this.app.use(koaStatic(publicDir));

    this.router.get('/', async ctx => {
      ctx.body = { name: 'qwen-provider proxy', version: '0.1.0' };
    });

    this.router.get('/health', async ctx => {
      ctx.body = { status: 'ok' };
    });

    // Management APIs
    this.router.get('/api/config', async ctx => {
      ctx.body = configStore.getConfig();
    });

    this.router.post('/api/config', async ctx => {
      const body = ctx.request.body as any;
      const updated = configStore.updateConfig(body);
      ctx.body = updated;
    });

    this.router.post('/api/provider/token', async ctx => {
      const {providerId, tokenKey = 'ticket', token, credentials, name} = ctx.request.body as any;
      if (!providerId || (!token && !credentials)) {
        ctx.status = 400;
        ctx.body = { error: 'providerId and token or credentials required' };
        return;
      }
      if (name && typeof name === 'string' && name.length > 0) {
        configStore.setProviderName(providerId, name);
      }
      if (credentials && typeof credentials === 'object') {
        for (const [key, value] of Object.entries(credentials)) {
          if (typeof value === 'string' && value.length > 0) {
            configStore.setProviderToken(providerId, key, value);
          }
        }
      } else {
        configStore.setProviderToken(providerId, tokenKey, token);
      }
      ctx.body = { success: true };
    });

    // OAuth config endpoints
    this.router.post('/api/provider/oauth-config', async ctx => {
      const {providerId, oauth} = ctx.request.body as any;
      if (!providerId || !oauth) {
        ctx.status = 400;
        ctx.body = { error: 'providerId and oauth config required' };
        return;
      }
      configStore.setProviderOAuthConfig(providerId, oauth);
      ctx.body = { success: true };
    });

    this.router.get('/api/provider/oauth-config', async ctx => {
      const providerId = ctx.query.providerId as string;
      if (!providerId) {
        ctx.status = 400;
        ctx.body = { error: 'providerId required' };
        return;
      }
      ctx.body = configStore.getProviderOAuthConfig(providerId);
    });

    this.router.get('/api/prompts', async ctx => {
      ctx.body = getAllPrompts();
    });

    this.router.post('/api/prompts', async ctx => {
      const body = ctx.request.body as any;
      if (!body || !body.id) {
        ctx.status = 400;
        ctx.body = { error: 'id and value required' };
        return;
      }
      setPromptOverride(String(body.id), String(body.value || ''));
      ctx.body = { ok: true, prompts: getAllPrompts() };
    });

    this.router.post('/api/prompts/reset', async ctx => {
      resetPromptOverrides();
      ctx.body = { ok: true, prompts: getAllPrompts() };
    });

    this.router.post('/api/provider/oauth/capture', async ctx => {
      const {providerId, timeout} = ctx.request.body as any;
      if (providerId !== 'qwen-ai') {
        ctx.status = 400;
        ctx.body = { success: false, error: 'Only qwen-ai auto capture is supported' };
        return;
      }

      const result = await captureQwenAiCredentials(Number(timeout) || undefined);
      if (!result.success || !result.credentials) {
        ctx.status = 400;
        ctx.body = result;
        return;
      }

      for (const [key, value] of Object.entries(result.credentials)) {
        if (value) {
          configStore.setProviderToken(providerId, key, value);
        }
      }

      ctx.body = result;
    });

    // Validate provider credentials using the same international Qwen web token logic as the sample app.
    this.router.post('/api/provider/validate', async ctx => {
      const { providerId, credentials } = ctx.request.body as any;
      if (!providerId || !credentials) {
        ctx.status = 400;
        ctx.body = { ok: false, error: 'providerId and credentials required' };
        return;
      }

      if (providerId === 'qwen-ai') {
        try {
          const adapter = new QwenAiOAuthAdapter();
          const result = await adapter.validateToken(credentials || {});
          ctx.body = {
            ok: !!result.valid,
            valid: !!result.valid,
            accountInfo: result.accountInfo,
            error: result.error,
          };
          return;
        } catch (err) {
          ctx.status = 500;
          ctx.body = { ok: false, error: err instanceof Error ? err.message : String(err) };
          return;
        }
      }

      ctx.status = 400;
      ctx.body = { ok: false, error: 'Unsupported provider' };
    });

    this.router.get('/api/provider/status', async ctx => {
      const providerId = String(ctx.query.providerId || '');
      if (!providerId) {
        ctx.status = 400;
        ctx.body = {ok: false, error: 'providerId required'};
        return;
      }

      if (providerId !== 'qwen-ai') {
        ctx.body = {ok: true, status: 'warn', detail: 'Unsupported provider'};
        return;
      }

      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === providerId);
      const credentials = providerConf?.credentials || {};
      if (!credentials.token && !credentials.cookies && !credentials.cookie) {
        ctx.body = {ok: true, status: 'dead', detail: 'No credentials'};
        return;
      }

      try {
        const adapter = new QwenAiOAuthAdapter();
        const result = await adapter.validateToken(credentials);
        if (result.valid) {
          ctx.body = {ok: true, status: 'alive', detail: 'Token valid'};
        } else {
          ctx.body = {ok: true, status: 'dead', detail: result.error || 'Token invalid'};
        }
      } catch (error) {
        ctx.body = {
          ok: true,
          status: 'warn',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    });

    // Start OAuth flow: redirect to provider authorize URL
    this.router.get('/auth/start/:providerId', async ctx => {
      const providerId = ctx.params.providerId;
      const oauth = configStore.getProviderOAuthConfig(providerId);
      if (!oauth || !oauth.authorizeUrl) {
        ctx.status = 400;
        ctx.body = { error: 'OAuth authorizeUrl not configured for provider' };
        return;
      }

      const state = Math.random().toString(36).slice(2);
      const origin = ctx.origin; // protocol + host
      const callbackUrl = `${origin}/auth/callback/${encodeURIComponent(providerId)}`;

      const params: any = {
        client_id: oauth.clientId,
        redirect_uri: callbackUrl,
        response_type: 'code',
        scope: (oauth.scopes || []).join(' '),
        state,
        ...(oauth.authorizeParams || {}),
      };

      const url = oauth.authorizeUrl + (oauth.authorizeUrl.includes('?') ? '&' : '?') + querystring.stringify(params);
      ctx.redirect(url);
    });

    // OAuth callback
    this.router.get('/auth/callback/:providerId', async ctx => {
      const providerId = ctx.params.providerId;
      const oauth = configStore.getProviderOAuthConfig(providerId);
      const q = ctx.query as any;

      // If token provided in query (some providers may return token directly)
      const tokenParamName = oauth?.tokenParamName || 'token';
      const tokenKey = oauth?.tokenKey || 'token';

      if (q[tokenParamName]) {
        const tokenVal = q[tokenParamName];
        configStore.setProviderToken(providerId, tokenKey, tokenVal);
        ctx.body = `<html><body><h3>Login successful</h3><p>Stored token for ${providerId}.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`;
        return;
      }

      // If code present and tokenUrl configured, exchange
      if (q.code && oauth && oauth.tokenUrl) {
        try {
          const origin = ctx.origin;
          const callbackUrl = `${origin}/auth/callback/${encodeURIComponent(providerId)}`;
          const body = {
            grant_type: 'authorization_code',
            code: q.code,
            redirect_uri: callbackUrl,
            client_id: oauth.clientId,
            client_secret: oauth.clientSecret,
          };

          const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
          const resp = await axios.post(oauth.tokenUrl, querystring.stringify(body), { headers });
          const tokenVal = resp.data && (resp.data.access_token || resp.data.token || resp.data.tongyi_sso_ticket || resp.data.ticket);
          if (tokenVal) {
            configStore.setProviderToken(providerId, tokenKey, tokenVal);
            ctx.body = `<html><body><h3>Login successful</h3><p>Stored token for ${providerId}.</p><script>setTimeout(()=>window.close(),1200)</script></body></html>`;
            return;
          }

          ctx.body = `<html><body><h3>Login exchange completed</h3><pre>${JSON.stringify(resp.data,null,2)}</pre><script>setTimeout(()=>window.close(),3000)</script></body></html>`;
          return;
        } catch (err) {
          console.error('[OAuth] token exchange failed', err);
          ctx.status = 500;
          ctx.body = `<html><body><h3>OAuth token exchange failed</h3><pre>${String(err)}</pre></body></html>`;
          return;
        }
      }

      ctx.body = `<html><body><h3>OAuth callback received</h3><pre>${JSON.stringify(q,null,2)}</pre></body></html>`;
    });

    this.router.get('/api/models', async ctx => {
      ctx.body = {
        providerId: 'qwen-ai',
        source: 'builtin-qwen-catalog',
        items: getQwenAiModelCatalog(),
        updatedAt: null,
      };
    });

    this.router.get('/v1/models', async ctx => {
      const config = configStore.getConfig();
      const requiredProxyKey = String(config.proxy?.key || '').trim();
      if (requiredProxyKey) {
        const authHeader = String(ctx.headers.authorization || '');
        const xProxyKey = String(ctx.headers['x-proxy-key'] || '');
        const bearer = authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : '';
        const providedKey = bearer || xProxyKey;
        if (providedKey !== requiredProxyKey) {
          ctx.status = 401;
          ctx.body = {error: {message: 'Unauthorized: invalid proxy key'}};
          return;
        }
      }

      const data = getQwenAiModelCatalog()
        .map(model => {
          const id = String(model.id || model.name || '').trim();
          if (!id) {
            return null;
          }
          return {
            id,
            object: 'model',
            created: 0,
            owned_by: 'qwen-ai',
            name: model.name || id,
          };
        })
        .filter((model): model is {
          id: string;
          object: 'model';
          created: number;
          owned_by: string;
          name: string;
        } => Boolean(model));

      ctx.set('Cache-Control', 'no-store');
      ctx.body = {
        object: 'list',
        data,
      };
    });

    this.router.post('/api/models', async ctx => {
      ctx.status = 405;
      ctx.body = {
        ok: false,
        error: 'Models are managed from the built-in Qwen catalog only',
      };
    });

    this.router.post('/api/models/refresh', async ctx => {
      try {
        const items = getQwenAiModelCatalog();
        configStore.setModels(items);
        ctx.body = {
          ok: true,
          providerId: 'qwen-ai',
          source: 'builtin-qwen-catalog',
          count: items.length,
          items,
          updatedAt: Date.now(),
        };
      } catch (error) {
        ctx.status = 500;
        ctx.body = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    this.router.get('/api/logs/stats', async ctx => {
      ctx.body = configStore.getLogsStats();
    });

    this.router.get('/api/logs', async ctx => {
      const limit = Number(ctx.query.limit || 200);
      ctx.body = configStore.getLogs(limit);
    });

    this.router.delete('/api/logs', async ctx => {
      configStore.clearLogs();

      const dirs = [
        path.join(process.cwd(), 'data', 'wire-logs'),
        path.join(process.cwd(), 'wire-logs'),
        path.join(process.cwd(), 'data', 'overflow'),
      ];

      for (const dir of dirs) {
        try {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
              const fp = path.join(dir, file);
              if (fs.statSync(fp).isFile()) {
                fs.unlinkSync(fp);
              }
            }
          }
        } catch (err) {
          console.error(`Failed to clear ${dir}:`, err);
        }
      }

      ctx.body = {ok: true};
    });

    this.router.get('/api/chat-cleanup/status', async ctx => {
      ctx.body = chatCleanupScheduler.status();
    });

    this.router.post('/api/chat-cleanup/run', async ctx => {
      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === 'qwen-ai');
      const account = providerConf ? getAccountsFromProviderConf(providerConf)[0] : undefined;
      if (!account) {
        ctx.status = 400;
        ctx.body = {error: 'No qwen-ai account configured'};
        return;
      }
      const adapter = new QwenAiAdapter({
        id: 'qwen-ai',
        apiEndpoint: 'https://chat.qwen.ai',
        chatPath: '/api/v2/chat/completions',
      } as Provider, account);
      ctx.body = {ok: true, ...(await chatCleanupScheduler.runOnce(adapter))};
    });

    this.router.get('/api/sessions', async ctx => {
      ctx.body = sessionStore.listSessions().map(s => ({
        id: s.id,
        source: s.source,
        workspace: s.workspace,
        threadId: s.threadId,
        title: s.title,
        model: s.model,
        providerSessionId: s.providerSessionId,
        contextHash: s.contextHash,
        turnCount: s.turnCount || 0,
        messageCount: s.messages.length,
        summary: s.summary,
        compactedAt: s.compactedAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        lastRequestAt: s.lastRequestAt,
        active: s.active,
      }));
    });

    this.router.get('/api/sessions/diagnostics', async ctx => {
      const conf = configStore.getConfig();
      const sessionCfg = conf.settings?.session || {};
      const allSessions = sessionStore.listSessions();
      const sessionsFilePath = path.join(process.cwd(), 'data', 'sessions.json');
      let fileExists = false;
      let fileParseable = false;
      try {
        if (fs.existsSync(sessionsFilePath)) {
          fileExists = true;
          const raw = fs.readFileSync(sessionsFilePath, 'utf8');
          JSON.parse(raw);
          fileParseable = true;
        }
      } catch {
        fileParseable = false;
      }
      ctx.body = {
        sessionEnabled: sessionCfg.enabled !== false,
        resolutionMode: 'context-hash',
        rollingHistoryK: Number(sessionCfg.rollingHistoryK) || 10,
        summaryEveryNTurns: Number(sessionCfg.summaryEveryNTurns) || 5,
        totalSessions: allSessions.length,
        stats: {
          persistent: allSessions.filter(s => s.mode === 'persistent' || !s.mode).length,
          indexed: allSessions.filter(s => !!s.contextHash).length,
          summarized: allSessions.filter(s => !!s.summary).length,
        },
        dataFile: {
          path: sessionsFilePath,
          exists: fileExists,
          parseable: fileParseable,
        },
      };
    });

    this.router.get('/api/sessions/:id', async ctx => {
      const session = sessionStore.getSession(ctx.params.id);
      if (!session) {
        ctx.status = 404;
        ctx.body = {error: 'Session not found'};
        return;
      }
      const activeRunDetails = (session.activeRunIds || [])
        .map(id => runStore.getRun(id))
        .filter(Boolean);
      ctx.body = {
        ...session,
        activeRunDetails,
      };
    });

    this.router.delete('/api/sessions/:id', async ctx => {
      const ok = sessionStore.deleteSession(ctx.params.id);
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.post('/api/sessions/:id/clear', async ctx => {
      const ok = sessionStore.clearSession(ctx.params.id);
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.post('/api/sessions/:id/compact', async ctx => {
      const session = sessionStore.getSession(ctx.params.id);
      if (!session) {
        ctx.status = 404;
        ctx.body = {error: 'Session not found'};
        return;
      }
      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === 'qwen-ai');
      const token = (providerConf?.credentials?.token) || process.env.QWEN_AI_TOKEN || '';
      const cookies = (providerConf?.credentials?.cookies || providerConf?.credentials?.cookie) || process.env.QWEN_AI_COOKIES || '';
      if (!token && !cookies) {
        ctx.status = 400;
        ctx.body = {error: 'Provider not configured'};
        return;
      }
      try {
        const summary = await compactSession(session.id, token, cookies);
        ctx.body = {ok: true, summary};
      } catch (err) {
        ctx.status = 500;
        ctx.body = {ok: false, error: err instanceof Error ? err.message : String(err)};
      }
    });

    this.router.post('/api/sessions/:id/rename', async ctx => {
      const {title} = ctx.request.body as any;
      if (!title) {
        ctx.status = 400;
        ctx.body = {error: 'title required'};
        return;
      }
      const ok = sessionStore.renameSession(ctx.params.id, String(title));
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.post('/api/sessions/reload', async ctx => {
      sessionStore.reload();
      ctx.body = {ok: true};
    });

    this.router.delete('/api/sessions', async ctx => {
      sessionStore.clearAll();
      ctx.body = {ok: true};
    });

    this.router.post('/api/sessions/:id/reset-provider', async ctx => {
      const body = ctx.request.body as any;
      const purpose = body?.purpose as string | undefined;
      const ok = await sessionStore.resetProviderSessionId(ctx.params.id, purpose);
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.get('/api/runs', async ctx => {
      const limit = Number(ctx.query.limit || 200);
      ctx.body = runStore.listRuns(limit);
    });

    this.router.get('/api/runs/:id', async ctx => {
      const run = runStore.getRun(ctx.params.id);
      if (!run) {
        ctx.status = 404;
        ctx.body = {error: 'Run not found'};
        return;
      }
      ctx.body = run;
    });

    this.router.delete('/api/runs/:id', async ctx => {
      const run = runStore.getRun(ctx.params.id);
      if (run?.sessionId) sessionStore.removeActiveRunId(run.sessionId, ctx.params.id);
      const ok = runStore.deleteRun(ctx.params.id);
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.delete('/api/runs', async ctx => {
      for (const run of runStore.listRuns(5000)) {
        if (run.sessionId) sessionStore.removeActiveRunId(run.sessionId, run.id);
      }
      runStore.clearAll();
      ctx.body = {ok: true};
    });

    this.router.post('/api/runs/:id/cancel', async ctx => {
      const run = runStore.getRun(ctx.params.id);
      if (!run) {
        ctx.status = 404;
        ctx.body = {error: 'Run not found'};
        return;
      }
      const terminal = ['completed', 'failed', 'cancelled'];
      if (terminal.includes(run.status)) {
        ctx.body = {ok: true, status: run.status, alreadyTerminal: true};
        return;
      }
      await abortRun(ctx.params.id, 'Cancelled by user');
      runStore.cancelRun(ctx.params.id);
      await releaseRun(ctx.params.id);
      if (run.sessionId) sessionStore.removeActiveRunId(run.sessionId, ctx.params.id);
      ctx.body = {ok: true, status: 'cancelled'};
    });

    this.router.post('/api/runs/:id/attach-session', async ctx => {
      const {sessionId} = ctx.request.body as any;
      if (!sessionId) {
        ctx.status = 400;
        ctx.body = {error: 'sessionId required'};
        return;
      }
      const run = runStore.getRun(ctx.params.id);
      if (!run) { ctx.status = 404; ctx.body = {error: 'Run not found'}; return; }
      runStore.updateRun(ctx.params.id, { sessionId: String(sessionId) });
      ctx.body = {ok: true};
    });

    this.router.get('/api/runtime', async ctx => {
      const diag = getRuntimeDiagnostics();
      ctx.body = {
        ...diag,
        activeRuns: runStore.getActiveRuns().map(r => ({
          id: r.id,
          status: r.status,
          providerId: r.providerId,
          accountId: r.accountId,
          providerChatId: r.providerChatId,
          sessionId: r.sessionId,
          workerId: r.workerId,
          startedAt: r.startedAt,
        })),
        workers: getWorkers().map(w => ({
          id: w.id,
          providerId: w.providerId,
          status: w.status,
          lastVerifiedIp: w.lastVerifiedIp,
        })),
      };
    });

    this.router.get('/api/provider-runtime', async ctx => {
      ctx.body = {
        config: getSchedulerConfig(),
        locks: lockManager.getSnapshot(),
        activeRuns: runStore.getActiveRuns().map(r => ({
          id: r.id,
          status: r.status,
          providerId: r.providerId,
          accountId: r.accountId,
          providerChatId: r.providerChatId,
          sessionId: r.sessionId,
          workerId: r.workerId,
          startedAt: r.startedAt,
        })),
      };
    });

    this.router.get('/api/network-profiles', async ctx => {
      ctx.body = getNetworkProfiles();
    });

    this.router.post('/api/network-profiles', async ctx => {
      const profile = ctx.request.body as any;
      ctx.body = upsertNetworkProfile(profile);
    });

    this.router.put('/api/network-profiles/:id', async ctx => {
      const profile = ctx.request.body as any;
      profile.id = ctx.params.id;
      ctx.body = upsertNetworkProfile(profile);
    });

    this.router.delete('/api/network-profiles/:id', async ctx => {
      const ok = deleteNetworkProfile(ctx.params.id);
      ctx.status = ok ? 200 : 404;
      ctx.body = {ok};
    });

    this.router.get('/api/egress/direct-ip', async ctx => {
      try {
        const result = await verifyDirectIp();
        ctx.body = result;
      } catch {
        ctx.body = { ip: 'unknown', source: 'error' };
      }
    });

    this.router.post('/api/network-profiles/:id/verify', async ctx => {
      try {
        const profile = getNetworkProfiles().find(p => p.id === ctx.params.id);
        if (!profile) { ctx.status = 404; ctx.body = { error: 'Profile not found' }; return; }
        const result = await verifyDirectIp(profile.verifyIpUrl);
        const match = profile.expectedIp ? result.ip === profile.expectedIp : true;
        upsertNetworkProfile({ ...profile, lastVerifiedIp: result.ip, lastVerifiedAt: Date.now() });
        ctx.body = { profileId: profile.id, ip: result.ip, expectedIp: profile.expectedIp, match };
      } catch (err) {
        ctx.status = 500;
        ctx.body = { error: err instanceof Error ? err.message : String(err) };
      }
    });

    this.router.get('/api/workers', async ctx => {
      ctx.body = getWorkers();
    });

    this.router.post('/api/workers', async ctx => {
      const w = ctx.request.body as ProviderWorker;
      ctx.body = upsertWorker(w);
    });

    this.router.put('/api/workers/:id', async ctx => {
      const w = ctx.request.body as ProviderWorker;
      w.id = ctx.params.id;
      ctx.body = upsertWorker(w);
    });

    this.router.delete('/api/workers/:id', async ctx => {
      ctx.body = { ok: deleteWorker(ctx.params.id) };
    });

    this.router.post('/api/workers/:id/verify-ip', async ctx => {
      const result = await verifyWorkerIp(ctx.params.id);
      if (!result) {
        ctx.status = 404;
        ctx.body = { error: 'Worker not found' };
        return;
      }
      ctx.body = result;
    });

    this.router.post('/api/workers/verify-all', async ctx => {
      const results = await Promise.all(getWorkers().map(w => verifyWorkerIp(w.id)));
      ctx.body = results;
    });

    this.router.post('/api/providers/:providerId/accounts/:accountId/reset-circuit', async ctx => {
      ctx.body = { ok: true, providerId: ctx.params.providerId, accountId: ctx.params.accountId };
    });

    this.router.post('/api/debug/qwen-roundtrip', async ctx => {
      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === 'qwen-ai');
      const token = (providerConf?.credentials?.token) || process.env.QWEN_AI_TOKEN || '';
      const cookies = (providerConf?.credentials?.cookies || providerConf?.credentials?.cookie) || process.env.QWEN_AI_COOKIES || '';
      const body = ctx.request.body as any;
      const model = body?.model || 'Qwen3.6-Plus';
      const messages = body?.messages || [{role: 'user', content: 'xin chao'}];

      const provider: Provider = {id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai', chatPath: '/api/v2/chat/completions'} as Provider;
      const account: Account = {id: 'debug', providerId: 'qwen-ai', name: 'debug', credentials: {token, cookies}} as Account;
      const adapter = new QwenAiAdapter(provider, account);

      const {response, chatId} = await adapter.chatCompletion({model, messages, stream: false} as any);
      const handler = new QwenAiStreamHandler(model);
      const completion = await handler.handleNonStream(response.data);
      const chatData = await adapter.getChatById(chatId);

      const historyMessages = chatData?.chat?.history?.messages || {};
      const currentId = chatData?.chat?.history?.currentId || chatData?.currentId;
      const currentMsg = currentId ? historyMessages[currentId] : null;
      const contentList = Array.isArray(currentMsg?.content_list) ? currentMsg.content_list : [];
      const answerItem = contentList.find((item: any) => item?.phase === 'answer');

      ctx.body = {
        ok: true,
        chatId,
        completionContent: completion?.choices?.[0]?.message?.content || '',
        chatCurrentId: currentId || null,
        answerFromChatById: answerItem?.content || '',
        contentListPhases: contentList.map((x: any) => ({phase: x?.phase, status: x?.status, len: (x?.content || '').length})),
      };
    });

    this.router.post('/api/debug/qwen-wire', async ctx => {
      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === 'qwen-ai');
      const token = (providerConf?.credentials?.token) || process.env.QWEN_AI_TOKEN || '';
      const cookies = (providerConf?.credentials?.cookies || providerConf?.credentials?.cookie) || process.env.QWEN_AI_COOKIES || '';
      const body = ctx.request.body as any;
      const model = body?.model || 'Qwen3.6-Plus';
      const messages = body?.messages || [{role: 'user', content: 'xin chao'}];

      const provider: Provider = {id: 'qwen-ai', apiEndpoint: 'https://chat.qwen.ai', chatPath: '/api/v2/chat/completions'} as Provider;
      const account: Account = {id: 'debug-wire', providerId: 'qwen-ai', name: 'debug-wire', credentials: {token, cookies}} as Account;
      const adapter = new QwenAiAdapter(provider, account);
      const {response, chatId} = await adapter.chatCompletion({model, messages, stream: true} as any);

      const firstChunks: string[] = [];
      let done = false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            resolve();
          }
        }, 2500);
        response.data.on('data', (buf: Buffer) => {
          if (firstChunks.length < 3) {
            firstChunks.push(buf.toString().slice(0, 600));
          }
        });
        response.data.on('end', () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        });
        response.data.on('error', () => {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve();
          }
        });
      });

      ctx.body = {
        ok: true,
        chatId,
        wire: adapter.getLastWireDebug(),
        firstChunks,
      };
    });

    this.router.post('/api/debug/qwen-file-flow', async ctx => {
      const conf = configStore.getConfig();
      const providerConf = conf.providers.find(p => p.id === 'qwen-ai');
      const token = (providerConf?.credentials?.token) || process.env.QWEN_AI_TOKEN || '';
      const cookies = (providerConf?.credentials?.cookies || providerConf?.credentials?.cookie) || process.env.QWEN_AI_COOKIES || '';
      if (!token && !cookies) {
        ctx.status = 400;
        ctx.body = {ok: false, error: 'Qwen credentials are not configured'};
        return;
      }

      const body = ctx.request.body as any;
      const model = body?.model || 'Qwen3.6-Plus';
      const marker = body?.marker || `QWEN_FILE_FLOW_MARKER_${Date.now()}`;
      const fileName = body?.filename || `qwen-file-flow-${Date.now()}.txt`;
      const fileContent = body?.content || [
        'This file is uploaded by Proxy-Luna debug file-flow test.',
        `Marker: ${marker}`,
        'If Qwen can read the attachment, it should repeat the marker exactly.',
      ].join('\n');
      const prompt = body?.prompt || [
        'Read the attached text file.',
        `Reply with the exact marker string only: ${marker}`,
      ].join('\n');

      const uploaded = await uploadOverflowFileToQwen(
        fileName,
        fileContent,
        token,
        cookies,
      );

      const provider: Provider = {
        id: 'qwen-ai',
        apiEndpoint: 'https://chat.qwen.ai',
        chatPath: '/api/v2/chat/completions',
        modelMappings: getQwenAiModelMappings() as any,
      } as Provider;
      const account: Account = {
        id: 'debug-file-flow',
        providerId: 'qwen-ai',
        name: 'debug-file-flow',
        credentials: {token, cookies},
      } as Account;

      const runAttachTest = async (
        mode: 'top_level_file_ids' | 'message_files_object',
      ): Promise<Record<string, any>> => {
        const adapter = new QwenAiAdapter(provider, account);
        const messages =
          mode === 'message_files_object'
            ? [
                {
                  role: 'user',
                  content: prompt,
                  files: [
                    {
                      file_id: uploaded.fileId,
                      url: uploaded.fileUrl,
                      file_url: uploaded.fileUrl,
                      filename: fileName,
                      file_name: fileName,
                      filetype: 'file',
                    },
                  ],
                },
              ]
            : [{role: 'user', content: prompt}];
        const request: Record<string, any> = {
          model,
          messages,
          stream: false,
        };
        if (mode === 'top_level_file_ids') {
          request.file_ids = [uploaded.fileId];
        }

        try {
          const {response, chatId} = await adapter.chatCompletion(request as any);
          const handler = new QwenAiStreamHandler(model);
          const transformed = await handler.handleStream(response.data);
          const completion = await collectNonStreamFromTransformedSSE(transformed, model);
          const content = completion?.choices?.[0]?.message?.content || '';
          return {
            mode,
            ok: !!content && content.includes(marker),
            chatId,
            content,
            wire: adapter.getLastWireDebug(),
          };
        } catch (error) {
          return {
            mode,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            wire: adapter.getLastWireDebug(),
          };
        }
      };

      const readFirstSseChunk = async (stream: any): Promise<string> => {
        return new Promise(resolve => {
          let done = false;
          const finish = (text: string) => {
            if (done) return;
            done = true;
            resolve(text.slice(0, 4000));
          };
          const timer = setTimeout(() => finish(''), 5000);
          stream.once('data', (buf: Buffer) => {
            clearTimeout(timer);
            finish(buf.toString('utf8'));
          });
          stream.once('end', () => {
            clearTimeout(timer);
            finish('');
          });
          stream.once('error', (err: Error) => {
            clearTimeout(timer);
            finish(String(err?.message || err));
          });
        });
      };

      const runRawAttachTest = async (
        mode: string,
      ): Promise<Record<string, any>> => {
        const adapter = new QwenAiAdapter(provider, account);
        const modelId = adapter.mapModel(model);
        const chatId = await adapter.createChat(modelId, `file-flow-${mode}`);
        await adapter.waitForFileParseStatus(uploaded.fileId, chatId);
        const ts = Math.floor(Date.now() / 1000);
        const fid = crypto.randomUUID();
        const childId = crypto.randomUUID();
        const fileFull = {
          file_id: uploaded.fileId,
          url: uploaded.fileUrl,
          file_url: uploaded.fileUrl,
          filename: fileName,
          file_name: fileName,
          filetype: 'file',
        };
        const fileWrapped = {
          type: 'file',
          file: {
            created_at: Date.now(),
            data: {},
            filename: fileName,
            hash: null,
            id: uploaded.fileId,
            user_id: '',
            meta: {
              name: fileName,
              size: Buffer.byteLength(fileContent, 'utf8'),
              content_type: 'text/plain',
              parse_meta: {
                parse_status: 'success',
              },
            },
            update_at: Date.now(),
          },
          id: uploaded.fileId,
          url: uploaded.fileUrl,
          name: fileName,
          collection_name: '',
          progress: 0,
          status: 'uploaded',
          greenNet: 'success',
          size: Buffer.byteLength(fileContent, 'utf8'),
          error: '',
          itemId: crypto.randomUUID(),
          file_type: 'text/plain',
          showType: 'file',
          file_class: 'document',
          uploadTaskId: crypto.randomUUID(),
        };
        const fileMinimal = {
          file_id: uploaded.fileId,
          filename: fileName,
          file_name: fileName,
          filetype: 'file',
        };
        const rawFiles =
          mode === 'files_full_with_file_ids' ? [fileFull]
          : mode === 'files_wrapped_no_top_file_ids' ? [fileWrapped]
          : mode === 'files_wrapped_with_file_ids' ? [fileWrapped]
          : mode === 'files_minimal_with_file_ids' ? [fileMinimal]
          : mode === 'files_id_only_with_file_ids' ? [{file_id: uploaded.fileId}]
          : mode === 'files_string_with_file_ids' ? [uploaded.fileId]
          : mode === 'files_full_no_top_file_ids' ? [fileFull]
          : [];
        const includeTopLevelFileIds =
          mode !== 'files_full_no_top_file_ids' &&
          mode !== 'files_wrapped_no_top_file_ids';
        const payload: Record<string, any> = {
          stream: true,
          version: '2.1',
          incremental_output: true,
          chat_id: chatId,
          chat_mode: 'normal',
          model: modelId,
          parent_id: null,
          messages: [
            {
              fid,
              parentId: null,
              childrenIds: [childId],
              role: 'user',
              content: prompt,
              user_action: 'chat',
              files: rawFiles,
              timestamp: ts,
              models: [modelId],
              chat_type: 't2t',
              feature_config: {
                thinking_enabled: false,
                output_schema: 'phase',
                research_mode: 'normal',
                auto_thinking: false,
                thinking_format: 'summary',
                auto_search: false,
              },
              extra: {meta: {subChatType: 't2t'}},
              sub_chat_type: 't2t',
              parent_id: null,
            },
          ],
          timestamp: ts + 1,
        };
        if (includeTopLevelFileIds) payload.file_ids = [uploaded.fileId];

        const response = await axios.post(
          `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`,
          payload,
          {
            headers: {
              ...buildQwenAiHeaders(token, cookies, chatId),
              'x-accel-buffering': 'no',
            },
            responseType: 'stream',
            timeout: 120000,
            validateStatus: () => true,
          },
        );
        const firstChunk = await readFirstSseChunk(response.data);
        try {
          response.data.destroy();
        } catch {}
        return {
          mode,
          chatId,
          status: response.status,
          sentFiles: rawFiles,
          sentFileIds: includeTopLevelFileIds ? [uploaded.fileId] : [],
          firstChunk,
          firstChunkHasError: /"error"\s*:/.test(firstChunk),
        };
      };

      const modes = Array.isArray(body?.modes) && body.modes.length > 0
        ? body.modes.filter((x: any) => x === 'top_level_file_ids' || x === 'message_files_object')
        : ['top_level_file_ids', 'message_files_object'];
      const attachTests = [];
      for (const mode of modes) {
        attachTests.push(await runAttachTest(mode));
      }
      const rawModes = Array.isArray(body?.rawModes)
        ? body.rawModes.filter((x: any) => typeof x === 'string')
        : [];
      const rawAttachTests = [];
      for (const mode of rawModes) {
        try {
          rawAttachTests.push(await runRawAttachTest(mode));
        } catch (error) {
          rawAttachTests.push({
            mode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      ctx.body = {
        ok: attachTests.some(x => x.ok) || rawAttachTests.some(x => x.firstChunk && !x.firstChunkHasError),
        marker,
        upload: {
          fileId: uploaded.fileId,
          fileUrl: uploaded.fileUrl,
          fileName,
          bytes: Buffer.byteLength(fileContent, 'utf8'),
        },
        attachTests,
        rawAttachTests,
      };
    });

    this.router.post('/v1/chat/completions', async ctx => {
      const startedAt = Date.now();
      const clientRequestHeaders = maskHeaders(ctx.headers as Record<string, any>);
      const conf = configStore.getConfig();
      const requiredProxyKey = String(conf.proxy?.key || '').trim();
      if (requiredProxyKey) {
        const authHeader = String(ctx.headers.authorization || '');
        const xProxyKey = String(ctx.headers['x-proxy-key'] || '');
        const bearer = authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : '';
        const providedKey = bearer || xProxyKey;
        if (providedKey !== requiredProxyKey) {
          ctx.status = 401;
          ctx.body = {error: {message: 'Unauthorized: invalid proxy key'}};
          return;
        }
      }

      const body = ctx.request.body as any;
      const model = body.model || 'Qwen3';
      const messages = body.messages || [];
      const rawPromptTokenEstimate = Array.isArray(messages)
        ? messages.reduce((sum: number, msg: any) => {
            const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content || '');
            return sum + estimateTokens(content);
          }, 0)
        : 0;


      const capturedPromptMessages: Array<Record<string, any>> = [];
      if (Array.isArray(messages)) {
        messages.forEach((m: any, i: number) => {
          const baseRole = String(m?.role || 'unknown');
          const content = m?.content;
          if (Array.isArray(content)) {
            content.forEach((part: any, pIndex: number) => {
              let partText = extractText(part);
              let role = baseRole;
              // detect likely tool output shapes: non-text typed parts or read_file-like markers
              if (part && typeof part === 'object' && typeof part.type === 'string' && part.type !== 'text') {
                role = 'tool';
              } else if (typeof partText === 'string' && /^\[.+for\s+/i.test(partText)) {
                role = 'tool';
              }
              capturedPromptMessages.push({ index: i, part: pIndex, role, content: partText });
            });
          } else {
            capturedPromptMessages.push({ index: i, role: baseRole, content: extractText(content) });
          }
        });
      }
      const lastUserMessage = [...messages].reverse().find((m: any) => m?.role === 'user');
      const promptPreview = typeof lastUserMessage?.content === 'string'
        ? lastUserMessage.content.slice(0, 180)
        : JSON.stringify(lastUserMessage?.content || '').slice(0, 180);

      const buildLoggedPromptMessages = (forceCompact = false) => {
        const tokenOverflowThreshold = Number(conf.settings?.tokenOverflow?.threshold || 10000);
        const shouldCompact = forceCompact || rawPromptTokenEstimate > tokenOverflowThreshold || capturedPromptMessages.length > 40;
        if (!shouldCompact) return capturedPromptMessages;
        const truncate = (value: any, max = 500) => {
          const text = String(value ?? '');
          return text.length > max ? `${text.slice(0, max)}...[truncated ${text.length - max} chars]` : text;
        };
        const head = capturedPromptMessages.slice(0, 3);
        const tail = capturedPromptMessages.slice(-8);
        return [
          {
            role: 'system',
            content: `[prompt log compacted] rawPromptTokenEstimate=${rawPromptTokenEstimate}, originalPromptMessages=${capturedPromptMessages.length}`,
          },
          ...head.map(item => ({...item, content: truncate(item.content)})),
          ...(capturedPromptMessages.length > head.length + tail.length
            ? [{role: 'system', content: `[${capturedPromptMessages.length - head.length - tail.length} prompt messages omitted from log]`}]
            : []),
          ...tail.map(item => ({...item, content: truncate(item.content)})),
        ];
      };

      const availableProviderIds = conf.providers.map(p => p.id);
      const providerId = selectProvider(model, body, ctx.headers as any, availableProviderIds);
      const providerConf = conf.providers.find(p => p.id === providerId);
      if (!providerConf) {
        ctx.status = 400;
        ctx.body = { error: { message: `Provider "${providerId}" not configured; add provider via UI or /api/provider/token` } };
        configStore.addLog('error', JSON.stringify({ path: '/v1/chat/completions', status: ctx.status, model, stream: !!body.stream, prompt: capturedPromptMessages, prompt_preview: promptPreview, prompt_messages: capturedPromptMessages, requestHeaders: {client: clientRequestHeaders}, responseHeaders: {client: getClientResponseHeaders(ctx)}, error: `Provider "${providerId}" not configured`, durationMs: Date.now() - startedAt }));
        return;
      }

      // Resolve accounts and pick one
      const accounts = getAccountsFromProviderConf(providerConf);
      if (accounts.length === 0) {
        ctx.status = 400;
        ctx.body = { error: { message: `No accounts available for provider "${providerId}"` } };
        configStore.addLog('error', JSON.stringify({ path: '/v1/chat/completions', status: ctx.status, model, stream: !!body.stream, requestHeaders: {client: clientRequestHeaders}, responseHeaders: {client: getClientResponseHeaders(ctx)}, error: `No accounts for provider "${providerId}"`, durationMs: Date.now() - startedAt }));
        return;
      }

      const preferredAccountId = body.account || body.metadata?.account_id || ctx.headers['x-luna-account-id'] as string;
      const account = selectAccount(providerId, accounts, preferredAccountId, (accId) => lockManager.currentCapacity(`account:${providerId}:${accId}`));
      if (!account) {
        ctx.status = 400;
        ctx.body = { error: { message: `No enabled account available for provider "${providerId}"` } };
        configStore.addLog('error', JSON.stringify({ path: '/v1/chat/completions', status: ctx.status, model, stream: !!body.stream, requestHeaders: {client: clientRequestHeaders}, responseHeaders: {client: getClientResponseHeaders(ctx)}, error: 'No enabled account', durationMs: Date.now() - startedAt }));
        return;
      }

      const token = (account.credentials.token) || process.env.QWEN_AI_TOKEN || '';
      const cookies = (account.credentials.cookies || account.credentials.cookie) || process.env.QWEN_AI_COOKIES || '';
      if (!token && !cookies) {
        ctx.status = 400;
        ctx.body = { error: { message: `Token/cookies not configured for account "${account.id}"; set via /api/provider/token or QWEN_AI_TOKEN env` } };
        configStore.addLog('error', JSON.stringify({ path: '/v1/chat/completions', status: ctx.status, model, stream: !!body.stream, prompt: capturedPromptMessages, prompt_preview: promptPreview, prompt_messages: capturedPromptMessages, requestHeaders: {client: clientRequestHeaders}, responseHeaders: {client: getClientResponseHeaders(ctx)}, error: `Token/cookies not configured for account "${account.id}"`, durationMs: Date.now() - startedAt }));
        return;
      }
      const stream = !!body.stream;
      const sessionCfg = conf.settings?.session || {};
      const sessionEnabled = sessionCfg.enabled !== false;
      let currentSession: StoredSession | null = null;
      let sessionIdForLog: string | undefined;
      let sessionMode: string = sessionEnabled ? 'stateless' : 'disabled';
      let sessionResolveReason: string = sessionEnabled ? 'hash_not_available' : 'disabled';
      let combinedMessages: any[] = messages;
      let inboundHash = '';

      if (sessionEnabled && messages.length > 0) {
        inboundHash = computeInboundContextHash(messages, model);
        if (inboundHash) {
          currentSession = sessionStore.resolveByContextHash(inboundHash) || null;
          if (currentSession) {
            sessionMode = 'persistent';
            sessionResolveReason = `context_hash_hit=${inboundHash.slice(0, 8)}`;
          } else {
            currentSession = sessionStore.createSession({model, source: 'auto'});
            await sessionStore.updateContextHash(currentSession.id, undefined, inboundHash);
            sessionMode = 'new';
            sessionResolveReason = `context_hash_miss_created=${inboundHash.slice(0, 8)}`;
          }
          sessionIdForLog = currentSession.id;
          sessionStore.setModel(currentSession.id, model);
        } else {
          sessionResolveReason = 'first_turn_waiting_for_response_hash';
        }
      }

      const rollingHistoryK = Number(sessionCfg.rollingHistoryK) || 10;
      if (currentSession?.summary && messages.length > rollingHistoryK) {
        combinedMessages = [
          {role: 'system', content: `[Conversation context summary]\n${currentSession.summary}`},
          ...messages.slice(-rollingHistoryK),
        ];
      }

      // Resolve provider binding / provider chat purpose
      let bindingPurpose: ProviderBinding['purpose'] = 'main';
      let providerSessionId: string | undefined;
      const explicitProviderSessionId = body.providerSessionId || body.provider_session_id || ctx.headers['x-luna-provider-session-id'] as string;
      if (explicitProviderSessionId) {
        providerSessionId = explicitProviderSessionId;
        bindingPurpose = 'main';
      } else if (currentSession) {
        const binding = sessionStore.getProviderBinding(currentSession.id, providerId, account.id, 'main');
        if (binding?.providerSessionId) {
          providerSessionId = binding.providerSessionId;
        } else if (currentSession.providerSessionId) {
          providerSessionId = currentSession.providerSessionId;
        }
      }

      // Check subagent metadata
      const subagentId = body.metadata?.subagent_id || body.metadata?.agent_id || ctx.headers['x-luna-subagent-id'] as string;
      if (subagentId) {
        bindingPurpose = 'subagent';
        if (currentSession) {
          const subBinding = sessionStore.getProviderBinding(currentSession.id, providerId, account.id, 'subagent');
          if (subBinding?.providerSessionId) {
            providerSessionId = subBinding.providerSessionId;
          }
        }
      }

      // ---- INPUT TOKEN GUARD ----
      const tokenLimitsCfg = conf.settings?.tokenLimits || {};
      const preGuardOverflowCfg = conf.settings?.tokenOverflow || {};
      const preGuardOverflowEnabled = preGuardOverflowCfg.enabled !== false;
      const preGuardOverflowThreshold = Number(preGuardOverflowCfg.threshold || 10000);
      if (tokenLimitsCfg.enabled !== false) {
        const maxInput = Number(tokenLimitsCfg.maxInputTokens) || 128000;
        const warnInput = Number(tokenLimitsCfg.warnInputTokens) || 100000;
        const inputValidation = validateInputSize(combinedMessages, maxInput, warnInput);
        const willUseOverflowFile = preGuardOverflowEnabled && rawPromptTokenEstimate > preGuardOverflowThreshold;
        if (!inputValidation.ok && !willUseOverflowFile) {
          ctx.status = 400;
          ctx.body = { error: { message: inputValidation.suggestion || 'Input exceeds maximum token limit', type: 'token_limit', totalTokens: inputValidation.totalTokens, maxInputTokens: inputValidation.maxInputTokens } };
          configStore.addLog('error', JSON.stringify({ path: '/v1/chat/completions', status: 400, model, stream: !!body.stream, error: inputValidation.suggestion, totalTokens: inputValidation.totalTokens, maxInputTokens: inputValidation.maxInputTokens, durationMs: Date.now() - startedAt }));
          return;
        }
        if (inputValidation.warn) {
          console.warn(`[TokenGuard] Warning: ${inputValidation.suggestion}`);
          configStore.addLog('info', JSON.stringify({ path: '/v1/chat/completions', warning: 'token_limit_approaching', totalTokens: inputValidation.totalTokens, maxInputTokens: inputValidation.maxInputTokens }));
        }
      }

      // ---- Extract max_tokens from request ----
      const requestedMaxTokens = Number(body.max_tokens || body.max_completion_tokens || 0);
      const maxOutputCap = Number(tokenLimitsCfg.maxOutputTokensCap) || 32000;
      const defaultMaxOutput = Number(tokenLimitsCfg.defaultMaxOutputTokens) || 8192;
      const effectiveMaxOutputTokens = requestedMaxTokens > 0
        ? Math.min(requestedMaxTokens, maxOutputCap)
        : defaultMaxOutput;

      const tokenOverflowCfg = conf.settings?.tokenOverflow || {};
      const tokenOverflowThreshold = Number(tokenOverflowCfg.threshold || 10000);
      const overflowInputMessages = rawPromptTokenEstimate > tokenOverflowThreshold ? messages : combinedMessages;
      const overflowResult = await applyTokenOverflowPolicy(
        overflowInputMessages,
        conf.settings || {},
        token,
        cookies,
        model,
        currentSession?.id,
      );
      let processedMessages = overflowResult.messages;
      const overflowSignalCfg = sessionCfg.overflowSignal || {};
      const overflowSignalMode = String(overflowSignalCfg.mode || 'auto');
      if (overflowSignalCfg.enabled && (overflowSignalMode === 'signal' || overflowSignalMode === 'both')) {
        const threshold = Number(overflowSignalCfg.signalThresholdTokens) || 90000;
        const tokenCount = processedMessages.reduce((sum, msg) => {
          const content = typeof msg?.content === 'string' ? msg.content : JSON.stringify(msg?.content || '');
          return sum + estimateTokens(content);
        }, 0);
        if (tokenCount > threshold) {
          ctx.status = 400;
          ctx.body = {
            error: {
              message: 'This conversation has exceeded the context limit. Please compact or summarize your conversation history.',
              type: 'invalid_request_error',
              code: 'context_length_exceeded',
              param: 'messages',
              luna_session_id: currentSession?.id,
            },
          };
          configStore.addLog('error', JSON.stringify({path: '/v1/chat/completions', status: 400, model, stream, error: 'context_length_exceeded', sessionId: currentSession?.id, durationMs: Date.now() - startedAt}));
          return;
        }
      }
      const openAiTools = convertOpenAiTools(body.tools);
      const openAiToolChoice = convertOpenAiToolChoice(body.tool_choice);
      const openAiToolModeEnabled = openAiTools.length > 0 && openAiToolChoice?.mode !== 'none';
      let openAiToolNames: string[] = [];
      if (openAiTools.length > 0) {
        const promptOverrides = getPromptOverrides();
        const injected = injectToolPrompt(
          normalizeOpenAiMessagesForTools(processedMessages),
          openAiTools,
          openAiToolChoice,
          promptOverrides,
        );
        processedMessages = buildQwenMessagesForToolPrompt(injected.messages);
        openAiToolNames = injected.toolNames;
      } else {
        processedMessages = normalizeToolMessages(processedMessages as any);
      }
      // Attach file-backed session if overflow created one and no explicit session
      const fileBackedSessionId = overflowResult.fileBackedSessionId || overflowResult.sanitizerMeta?.fileBackedSessionId as string | undefined;
      if (!currentSession && fileBackedSessionId) {
        const fbSession = sessionStore.getSession(fileBackedSessionId);
        if (fbSession) {
          currentSession = fbSession;
          sessionMode = 'file-backed';
          sessionResolveReason = 'overflow_file_backed_attached';
        }
      }

      const promptContractInjected = openAiToolModeEnabled;
      const responseXmlPassthroughEnabled = !openAiToolModeEnabled;

      // Create run with full metadata
      const currentRun = runStore.createRun({
        providerId,
        accountId: account.id,
        providerChatId: providerSessionId,
        model,
        stream,
        sessionId: currentSession?.id,
        activeTaskPreview: promptPreview,
        status: 'queued',
      });
      if (currentSession?.id) {
        sessionStore.addActiveRunId(currentSession.id, currentRun.id);
      }

      // Schedule with providerChatId for chat lock
      // Egress isolation check — must be before scheduleRun (needs workerId)
      const egressCfg = conf.settings?.egressIsolation || {};
      const isolationEnabled = egressCfg.enabled === true;
      let worker: ProviderWorker | undefined;
      let workerClient: WorkerClient | undefined;
      if (isolationEnabled) {
        const workers = getWorkers();
        worker = selectWorker({
          providerId,
          accountId: account.id,
          networkProfileId: account.networkProfileId,
          workers,
          requireVerified: egressCfg.verifyBeforeUse !== false,
          strictMode: egressCfg.strict !== false,
        });
        if (!worker) {
          if (egressCfg.strict !== false || !egressCfg.fallbackToDirect) {
            runStore.updateRun(currentRun.id, { status: 'failed', error: 'No verified worker available in strict isolation mode' });
            if (currentSession?.id) sessionStore.removeActiveRunId(currentSession.id, currentRun.id);
            await releaseRun(currentRun.id);
            ctx.status = 503;
            ctx.body = { error: { message: 'IP isolation strict — no verified worker available. Provider call blocked.', runId: currentRun.id } };
            return;
          }
          console.warn('[Egress] Isolation enabled but no worker, falling back to direct (non-strict mode)');
        } else {
          workerClient = new WorkerClient(worker);
          runStore.updateRun(currentRun.id, {
            workerId: worker.id,
            networkProfileId: worker.networkProfileId,
            outboundIp: worker.lastVerifiedIp,
          });
        }
      }

      const scheduleResult = await scheduleRun(currentRun.id, providerId, account.id, providerSessionId, {
        providerMax: account.maxConcurrentRuns || providerConf.maxConcurrentRuns,
        accountMax: account.maxConcurrentRuns,
        workerId: worker?.id,
        workerMax: 1,
      });
      if (!scheduleResult.ok) {
        runStore.updateRun(currentRun.id, { status: 'failed', error: scheduleResult.reason });
        if (currentSession?.id) sessionStore.removeActiveRunId(currentSession.id, currentRun.id);
        await releaseRun(currentRun.id);
        ctx.status = 503;
        ctx.body = { error: { message: `Scheduler queue timeout: ${scheduleResult.reason}`, runId: currentRun.id } };
        return;
      }
      runStore.updateRun(currentRun.id, { status: 'routing' });
      startRunTimeout(currentRun.id);

      const abortController = new AbortController();
      registerRunController(currentRun.id, {
        runId: currentRun.id,
        abortController,
        workerClient,
        workerRunId: undefined,
      });

      let finalized = false;
      const finalizeRun = async (status: 'completed' | 'failed' | 'cancelled', extra?: { error?: string; providerChatId?: string; fileBackedSessionId?: string }) => {
        if (finalized) return;
        finalized = true;
        unregisterRunController(currentRun.id);
        runStore.updateRun(currentRun.id, {
          status,
          error: extra?.error,
          providerChatId: extra?.providerChatId ?? currentRun.providerChatId,
        });
        if (currentSession?.id) {
          sessionStore.removeActiveRunId(currentSession.id, currentRun.id);
        }
        try {
          await releaseRun(currentRun.id);
        } catch (err) {
          console.warn('[Runtime] releaseRun failed', currentRun.id, err);
        }
        const cleanupCfg = configStore.getConfig().settings?.session?.chatCleanup || {};
        if (status === 'completed' && cleanupCfg.enabled && cleanupCfg.afterResponse) {
          chatCleanupScheduler.scheduleDeleteAfterResponse(extra?.providerChatId ?? currentRun.providerChatId, adapter);
        }
      };

      const ensureSessionAfterResponse = async (responseText: string) => {
        if (!sessionEnabled || !responseText) return;
        if (!currentSession) {
          currentSession = sessionStore.createSession({model, source: 'auto'});
          sessionMode = 'new';
          sessionResolveReason = 'first_turn_created_after_response';
          runStore.updateRun(currentRun.id, {sessionId: currentSession.id});
          sessionStore.addActiveRunId(currentSession.id, currentRun.id);
        }
        const outboundHash = computeOutboundContextHash(messages, responseText, model);
        if (outboundHash) {
          await sessionStore.updateContextHash(currentSession.id, inboundHash || currentSession.contextHash, outboundHash);
        }
      };

      // Client disconnect handler — only for non-stream or before stream body is set
      // For stream, the stream's own close/end events handle completion vs abort
      ctx.res.on('close', () => {
        if (!finalized && !stream) {
          abortRun(currentRun.id, 'Client disconnected').catch(() => {});
          finalizeRun('cancelled', { error: 'Client disconnected' }).catch(() => {});
        }
      });


      let adapter: QwenAiAdapter | null = null;
      let streamLogWritten = false;
      let workerChatId: string | undefined;
      let workerResponseHeaders: Record<string, any> | undefined;

      const buildLogEntry = (level: 'info' | 'error', extra: Record<string, any>) => {
        const wireDebug = adapter?.getLastWireDebug?.() || null;
        const providerRequestHeaders = wireDebug?.requestHeaders ? maskHeaders(wireDebug.requestHeaders) : {};
        const providerResponseHeaders = wireDebug?.responseHeaders
          ? maskHeaders(wireDebug.responseHeaders)
          : maskHeaders(workerResponseHeaders);
        const requestHeaders = {
          client: clientRequestHeaders,
          provider: providerRequestHeaders,
        };
        const responseHeaders = {
          client: getClientResponseHeaders(ctx),
          provider: providerResponseHeaders,
        };
        configStore.addLog(level, JSON.stringify({
          path: '/v1/chat/completions',
          model,
          stream,
          prompt_preview: promptPreview,
          prompt_messages: capturedPromptMessages,
          durationMs: Date.now() - startedAt,
          requestHeaders,
          responseHeaders,
          workerId: worker?.id || null,
          networkProfileId: worker?.networkProfileId || null,
          outboundIp: worker?.lastVerifiedIp || null,
          session: {
            enabled: sessionEnabled,
            mode: sessionMode,
            id: currentSession?.id || null,
            source: currentSession?.source || null,
            workspace: currentSession?.workspace || null,
            threadId: currentSession?.threadId || null,
            explicit: sessionMode === 'persistent',
            providerSessionId: currentSession?.providerSessionId || null,
            resolveReason: sessionResolveReason || null,
          },
          ...extra,
        }));
      };

      try {
        runStore.updateRun(currentRun.id, { status: 'streaming', startedAt: Date.now() });

        const chatCompletionParams: any = {
          model,
          messages: processedMessages,
          stream,
          originalModel: model,
          files: overflowResult.files || [],
          file_ids: [...overflowResult.fileIds, ...(Array.isArray(body.file_ids) ? body.file_ids : [])],
          providerSessionId,
          enable_thinking: typeof body.enable_thinking === 'boolean' ? body.enable_thinking : undefined,
          enableThinking: typeof body.enableThinking === 'boolean' ? body.enableThinking : undefined,
          thinking_mode: body.thinking_mode || body.qwen_thinking_mode,
          thinkingMode: body.thinkingMode || body.qwenThinkingMode,
          reasoning_effort: body.reasoning_effort,
          reasoning: body.reasoning,
          thinking_budget: body.thinking_budget,
          enableWebSearch: !!body.enableWebSearch,
        };

        if (workerClient) {
          // ---- WORKER MODE ----
          console.log('[Egress] Forwarding via worker:', worker?.id, worker?.lastVerifiedIp);
          runStore.updateRun(currentRun.id, { status: 'streaming' });

          const workerResponse = await workerClient.forwardChatCompletion(
            { ...chatCompletionParams, signal: undefined },
            abortController.signal,
          );
          workerResponseHeaders = workerResponse.headers;

          if (stream) {
            ctx.status = 200;
            ctx.set('Content-Type', 'text/event-stream');
            ctx.set('Cache-Control', 'no-cache');
            ctx.set('Connection', 'keep-alive');
            if (currentSession) {
              ctx.set('x-luna-session-id', currentSession.id);
              ctx.set('x-luna-thread-id', currentSession.threadId);
            }

            let capturedResponse = '';
            const rawStream = workerResponse.data;
            rawStream.on('data', (chunk: Buffer | string) => { capturedResponse += chunk.toString(); });

            // Forward to client by piping the raw stream
            ctx.body = rawStream;
            ctx.res.flushHeaders();

            rawStream.once('end', () => {
              buildLogEntry('info', {
                status: 200, workerMode: true, workerId: worker?.id,
                prompt_messages: capturedPromptMessages, sessionId: currentSession?.id,
              });
              finalizeRun('completed', { providerChatId: workerChatId }).catch(() => {});
            });
            rawStream.once('error', (err: Error) => {
              console.warn('[Egress] Worker stream error:', err);
              finalizeRun('failed', { error: err.message }).catch(() => {});
            });
            return;
          }

          // Non-stream worker mode: collect full response
          const chunks: Buffer[] = [];
          const rawStream = workerResponse.data;
          rawStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          await new Promise<void>((resolve, reject) => {
            rawStream.once('end', resolve);
            rawStream.once('error', reject);
          });
          const fullBody = Buffer.concat(chunks).toString('utf8');
          const result = JSON.parse(fullBody);
          ctx.status = 200;
          ctx.body = {
            ...result,
            luna_session: currentSession ? { id: currentSession.id, threadId: currentSession.threadId, source: currentSession.source } : undefined,
          };
          if (currentSession?.id) {
            ctx.set('x-luna-session-id', currentSession.id);
            ctx.set('x-luna-thread-id', currentSession.threadId);
          }
          buildLogEntry('info', { status: 200, workerMode: true, workerId: worker?.id, prompt_messages: capturedPromptMessages, sessionId: currentSession?.id });
          await finalizeRun('completed');
          return;
        }

        // ---- DIRECT MODE (no worker) ----
        // Use providerFactory if available, fall back to direct QwenAiAdapter
        let directAdapter: any;
        try {
          directAdapter = createAdapter({ providerId, account, settings: conf.settings, networkProfile: undefined });
          if (typeof directAdapter?.getLastWireDebug === 'function') {
            adapter = directAdapter;
          }
        } catch (e) {
          // Fallback: direct QwenAiAdapter for qwen-ai
          if (providerId === 'qwen-ai') {
            const provider: Provider = {
              id: 'qwen-ai',
              apiEndpoint: 'https://chat.qwen.ai',
              chatPath: '/api/v2/chat/completions',
              modelMappings: getQwenAiModelMappings() as any,
            } as Provider;
            adapter = new QwenAiAdapter(provider, account);
            directAdapter = adapter;
          } else {
            throw new Error(`No adapter available for provider: ${providerId}`);
          }
        }

        // Use resolved providerSessionId, or pre-create if files need waiting
        let effectiveProviderSessionId = providerSessionId;
        const incomingFileIds = [
          ...(overflowResult.fileIds || []),
          ...(Array.isArray(body.file_ids) ? body.file_ids : []),
        ].filter(Boolean);
        if (incomingFileIds.length > 0 && !effectiveProviderSessionId && adapter) {
          try {
            const mappedModel = adapter.mapModel(model);
            effectiveProviderSessionId = await adapter.createChat(mappedModel, 'OpenAI_API_Chat');
            for (const fid of Array.from(new Set(incomingFileIds))) {
              try { await adapter.waitForFileParseStatus(fid, effectiveProviderSessionId); } catch (e) { console.warn('[Server] waitForFileParseStatus failed for', fid, e); }
            }
            if (incomingFileIds.length > 0) await new Promise(r => setTimeout(r, 800));
          } catch (err) {
            console.warn('[Server] Pre-wait for file parse failed:', err);
          }
        }
        chatCompletionParams.providerSessionId = effectiveProviderSessionId;
        chatCompletionParams.signal = abortController.signal;

        const { response, chatId } = await directAdapter.chatCompletion(chatCompletionParams);

        // Update provider binding
        if (currentSession && chatId && bindingPurpose !== 'stateless') {
          const existingBinding = currentSession.providerBindings?.find(
            b => b.providerId === providerId && b.accountId === account.id && b.purpose === bindingPurpose
          );
          await sessionStore.upsertProviderBinding(currentSession.id, {
            providerId,
            accountId: account.id,
            providerSessionId: chatId,
            purpose: bindingPurpose,
            workerId: worker?.id,
            createdAt: existingBinding?.createdAt ?? Date.now(),
            updatedAt: Date.now(),
          });
        }

        if (stream) {
          const handler = new QwenAiStreamHandler(model, async sid => {});
          handler.xmlPassthrough = responseXmlPassthroughEnabled;
          handler.maxOutputTokens = effectiveMaxOutputTokens;
          const transformed = await handler.handleStream(response.data);

          ctx.status = 200;
          ctx.set('Content-Type', 'text/event-stream');
          ctx.set('Cache-Control', 'no-cache');
          ctx.set('Connection', 'keep-alive');
          ctx.body = transformed as any;
          let capturedResponse = '';
          transformed.on('data', (chunk: Buffer | string) => { capturedResponse += chunk.toString(); });

          const persistStreamLog = async () => {
            if (streamLogWritten) return;
            streamLogWritten = true;
            try {
              const captureStream = new (require('stream').PassThrough)();
              captureStream.end(capturedResponse);
              const parsed = await collectNonStreamFromTransformedSSE(captureStream, model);
              const parsedText = parsed?.choices?.[0]?.message?.content || '';
              await ensureSessionAfterResponse(parsedText);
              if (currentSession) {
                await acquireSessionWriteLock(currentSession.id);
                try {
                  persistSessionMessages(currentSession.id, messages, parsed, overflowResult, { runId: currentRun.id, providerId, accountId: account.id, providerSessionId: chatId });
                } finally { releaseSessionWriteLock(currentSession.id); }
              }
              buildLogEntry('info', { status: 200, thinking_mode: body.thinking_mode || '', reasoning_effort: body.reasoning_effort || '', files: (overflowResult.files || []).length + (Array.isArray(body.file_ids) ? body.file_ids.length : 0), overflow: (overflowResult.fileIds || []).length > 0, sanitized: overflowResult.sanitized, sanitizerMeta: overflowResult.sanitizerMeta, rawPromptTokenEstimate, clineOutput: analyzeResponseXml(parsed?.choices?.[0]?.message?.content), providerToolMode: 'disabled', xmlPassthroughContract: promptContractInjected, responseXmlPassthrough: responseXmlPassthroughEnabled, response: parsed, prompt_messages: buildLoggedPromptMessages((overflowResult.fileIds || []).length > 0), sessionId: currentSession?.id });
              await finalizeRun('completed', { providerChatId: chatId });
            } catch (err) {
              await ensureSessionAfterResponse(capturedResponse);
              if (currentSession) {
                await acquireSessionWriteLock(currentSession.id);
                try {
                  persistSessionMessages(currentSession.id, messages, capturedResponse, overflowResult, { runId: currentRun.id, providerId, accountId: account.id, providerSessionId: chatId });
                } finally { releaseSessionWriteLock(currentSession.id); }
              }
              buildLogEntry('info', { status: 200, thinking_mode: body.thinking_mode || '', reasoning_effort: body.reasoning_effort || '', files: (overflowResult.files || []).length + (Array.isArray(body.file_ids) ? body.file_ids.length : 0), overflow: (overflowResult.fileIds || []).length > 0, sanitized: overflowResult.sanitized, sanitizerMeta: overflowResult.sanitizerMeta, rawPromptTokenEstimate, clineOutput: analyzeResponseXml(capturedResponse), providerToolMode: 'disabled', xmlPassthroughContract: promptContractInjected, responseXmlPassthrough: responseXmlPassthroughEnabled, response: capturedResponse, responseParseError: err instanceof Error ? err.message : String(err), prompt_messages: buildLoggedPromptMessages((overflowResult.fileIds || []).length > 0), sessionId: currentSession?.id });
              await finalizeRun('completed', { providerChatId: chatId });
            }
          };
          transformed.once('end', () => { void persistStreamLog(); });
          transformed.once('close', () => { void persistStreamLog(); });
          if (currentSession) {
            ctx.set('x-luna-session-id', currentSession.id);
            ctx.set('x-luna-thread-id', currentSession.threadId);
            if (chatId) ctx.set('x-luna-provider-session-id', chatId);
          }
          return;
        }

        // Non-stream
        const nshandler = new QwenAiStreamHandler(model);
        nshandler.xmlPassthrough = responseXmlPassthroughEnabled;
        const nstransformed = await nshandler.handleStream(response.data);
        const result = await collectNonStreamFromTransformedSSE(nstransformed, model);
        const resultContent = result?.choices?.[0]?.message?.content || '';
        await ensureSessionAfterResponse(resultContent);
        ctx.status = 200;
        ctx.body = {
          ...result,
          luna_session: currentSession ? { id: currentSession.id, threadId: currentSession.threadId, source: currentSession.source, providerSessionId: chatId || currentSession.providerSessionId || null } : undefined,
        };
        if (currentSession) {
          await acquireSessionWriteLock(currentSession.id);
          try {
            persistSessionMessages(currentSession.id, messages, result, overflowResult, { runId: currentRun.id, providerId, accountId: account.id, providerSessionId: chatId });
          } finally { releaseSessionWriteLock(currentSession.id); }
          ctx.set('x-luna-session-id', currentSession.id);
          ctx.set('x-luna-thread-id', currentSession.threadId);
          if (chatId) ctx.set('x-luna-provider-session-id', chatId);
        }
        buildLogEntry('info', { status: 200, thinking_mode: body.thinking_mode || '', reasoning_effort: body.reasoning_effort || '', files: (overflowResult.files || []).length + (Array.isArray(body.file_ids) ? body.file_ids.length : 0), overflow: (overflowResult.fileIds || []).length > 0, sanitized: overflowResult.sanitized, sanitizerMeta: overflowResult.sanitizerMeta, rawPromptTokenEstimate, clineOutput: analyzeResponseXml(resultContent), providerToolMode: 'disabled', xmlPassthroughContract: promptContractInjected, responseXmlPassthrough: responseXmlPassthroughEnabled, response: result, prompt_messages: buildLoggedPromptMessages((overflowResult.fileIds || []).length > 0), sessionId: currentSession?.id });
        await finalizeRun('completed', { providerChatId: chatId });
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          await finalizeRun('cancelled', { error: 'Request aborted' });
          if (!ctx.body) { ctx.status = 499; ctx.body = { error: { message: 'Request aborted', runId: currentRun.id } }; }
          return;
        }

        // Normalize upstream errors for proper status codes
        const errMsg = err instanceof Error ? err.message : String(err);
        const upstreamErr = normalizeUpstreamError(undefined, errMsg, errMsg);
        if (upstreamErr) {
          ctx.status = upstreamErr.statusCode;
          ctx.body = formatUpstreamErrorResponse(upstreamErr);
          await finalizeRun('failed', { error: upstreamErr.message });
          buildLogEntry('error', { status: upstreamErr.statusCode, error: upstreamErr.message, errorType: upstreamErr.errorType, retryable: upstreamErr.retryable, prompt_messages: capturedPromptMessages, sessionId: currentSession?.id });
        } else {
          ctx.status = 500;
          ctx.body = { error: { message: errMsg } };
          await finalizeRun('failed', { error: errMsg });
          buildLogEntry('error', { status: 500, error: errMsg, prompt_messages: capturedPromptMessages, sessionId: currentSession?.id });
        }
      }
    });

    // ===== Anthropic-compatible endpoint =====
    this.router.post('/v1/messages', async ctx => {
      const startedAt = Date.now();
      const clientRequestHeaders = maskHeaders(ctx.headers as Record<string, any>);
      const conf = configStore.getConfig();
      const requiredProxyKey = String(conf.proxy?.key || '').trim();
      if (requiredProxyKey) {
        const authHeader = String(ctx.headers.authorization || '');
        const xApiKey = String(ctx.headers['x-api-key'] || '');
        const bearer = authHeader.toLowerCase().startsWith('bearer ')
          ? authHeader.slice(7).trim()
          : '';
        const providedKey = bearer || xApiKey;
        if (providedKey !== requiredProxyKey) {
          ctx.status = 401;
          ctx.body = { error: { message: 'Unauthorized: invalid proxy key' } };
          return;
        }
      }

      const anthropicVersion = String(ctx.headers['anthropic-version'] || '').trim();
      if (anthropicVersion && !/^\d{4}-\d{2}-\d{2}$/.test(anthropicVersion)) {
        ctx.status = 400;
        ctx.body = { error: { message: `Invalid anthropic-version: ${anthropicVersion}. Expected format YYYY-MM-DD.` } };
        return;
      }

      const body = ctx.request.body as any;
      if (!body) {
        ctx.status = 400;
        ctx.body = { error: { message: 'Request body required' } };
        return;
      }

      try {
        const internalReq = convertToInternalRequest(body);
        const stream = !!body.stream;

        const availableProviderIds = conf.providers.map(p => p.id);
        const providerId = selectProvider(internalReq.model, body, ctx.headers as any, availableProviderIds);
        const providerConf = conf.providers.find(p => p.id === providerId);
        if (!providerConf) {
          ctx.status = 400;
          ctx.body = { error: { message: `Provider "${providerId}" not configured` } };
          return;
        }

        const accounts = getAccountsFromProviderConf(providerConf);
        if (accounts.length === 0) {
          ctx.status = 400;
          ctx.body = { error: { message: `No accounts available for provider "${providerId}"` } };
          return;
        }

        const preferredAccountId = body.account || body.metadata?.account_id || ctx.headers['x-luna-account-id'] as string;
        const account = selectAccount(providerId, accounts, preferredAccountId, (accId) => lockManager.currentCapacity(`account:${providerId}:${accId}`));
        if (!account) {
          ctx.status = 400;
          ctx.body = { error: { message: `No enabled account available for provider "${providerId}"` } };
          return;
        }

        const token = (account.credentials.token) || process.env.QWEN_AI_TOKEN || '';
        const cookies = (account.credentials.cookies || account.credentials.cookie) || process.env.QWEN_AI_COOKIES || '';
        if (!token && !cookies) {
          ctx.status = 400;
          ctx.body = { error: { message: `Token/cookies not configured for account "${account.id}"` } };
          return;
        }

        const promptOverrides = getPromptOverrides();
        const { messages: injectedMessages, toolNames } = injectToolPrompt(
          internalReq.messages,
          internalReq.tools || [],
          internalReq.toolChoice,
          promptOverrides,
        );
        // ---- INPUT TOKEN GUARD (Anthropic) ----
        const anthropicTokenLimitsCfg = conf.settings?.tokenLimits || {};
        if (anthropicTokenLimitsCfg.enabled !== false) {
          const maxInput = Number(anthropicTokenLimitsCfg.maxInputTokens) || 128000;
          const warnInput = Number(anthropicTokenLimitsCfg.warnInputTokens) || 100000;
          const inputValidation = validateInputSize(injectedMessages, maxInput, warnInput);
          if (!inputValidation.ok) {
            ctx.status = 400;
            ctx.body = { type: 'error', error: { type: 'invalid_request_error', message: inputValidation.suggestion || 'Input exceeds maximum token limit' } };
            return;
          }
          if (inputValidation.warn) {
            console.warn(`[TokenGuard/Anthropic] Warning: ${inputValidation.suggestion}`);
          }
        }

        const overflowResult = await applyTokenOverflowPolicy(
          injectedMessages,
          conf.settings || {},
          token,
          cookies,
          internalReq.model,
        );
        const processedMessages = overflowResult.messages;

        let systemContent = '';
        let userContent = '';
        for (const msg of processedMessages) {
          if (msg.role === 'system') {
            systemContent += (systemContent ? '\n\n' : '') + msg.content;
          } else if (msg.role === 'user') {
            userContent += (userContent ? '\n' : '') + msg.content;
          }
        }

        const chatMessages: any[] = [];
        if (systemContent) {
          chatMessages.push({ role: 'system', content: systemContent });
        }

        const nonSystemMsgs = processedMessages.filter(m => m.role !== 'system');
        const lastUserIdx = [...nonSystemMsgs].reverse().findIndex(m => m.role === 'user');
        if (lastUserIdx >= 0) {
          const transcriptParts: string[] = [];
          for (let i = 0; i < nonSystemMsgs.length; i++) {
            const m = nonSystemMsgs[i];
            transcriptParts.push(`${m.role}:${m.content}`);
          }
          const transcript = transcriptParts.join(';');
          chatMessages.push({ role: 'user', content: transcript });
        } else {
          chatMessages.push({ role: 'user', content: userContent || 'Hello' });
        }

        // Create adapter and call Qwen
        let adapter: QwenAiAdapter;
        if (providerId === 'qwen-ai') {
          const provider: Provider = {
            id: 'qwen-ai',
            apiEndpoint: 'https://chat.qwen.ai',
            chatPath: '/api/v2/chat/completions',
            modelMappings: getQwenAiModelMappings() as any,
          } as Provider;
          adapter = new QwenAiAdapter(provider, account);
        } else {
          ctx.status = 400;
          ctx.body = { error: { message: `Unsupported provider: ${providerId} for Anthropic endpoint` } };
          return;
        }

        const { response, chatId } = await adapter.chatCompletion({
          model: internalReq.model,
          messages: chatMessages,
          stream: true,
          files: overflowResult.files || [],
          file_ids: overflowResult.fileIds || [],
          signal: undefined,
        });

        const inputTokens = estimateAnthropicInputTokens(body);
        const messageId = `msg_${chatId || Date.now().toString(36)}`;

        if (stream) {
          // Stream mode: collect full SSE, parse tool calls, emit Anthropic SSE
          const handler = new QwenAiStreamHandler(internalReq.model);
          handler.xmlPassthrough = true;
          const transformed = await handler.handleStream(response.data);

          let fullContent = '';
          const streamedToolCalls: any[] = [];
          transformed.on('data', (chunk: Buffer) => {
            const text = chunk.toString();
            const dataLines = text.split('\n').filter(line => line.startsWith('data: '));
            for (const line of dataLines) {
              try {
                const parsed = JSON.parse(line.slice(6));
                const delta = parsed?.choices?.[0]?.delta;
                if (delta?.content) {
                  fullContent += delta.content;
                }
                if (Array.isArray(delta?.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const index = typeof tc?.index === 'number' ? tc.index : streamedToolCalls.length;
                    const existing = streamedToolCalls[index] || { index };
                    streamedToolCalls[index] = {
                      ...existing,
                      ...tc,
                      function: {
                        ...(existing.function || {}),
                        ...(tc.function || {}),
                        name: tc.function?.name ?? existing.function?.name,
                        arguments: `${existing.function?.arguments || ''}${tc.function?.arguments || ''}`,
                      },
                    };
                  }
                }
              } catch {}
            }
          });

          const anthropicStream = createAnthropicStream(internalReq.model, messageId);

          transformed.once('end', () => {
            const toolCalls = streamedToolCalls.filter(Boolean).map((tc: any) => {
              let input = {};
              try {
                input = JSON.parse(tc.function?.arguments || '{}');
              } catch {}
              return {
                id: tc.id,
                name: tc.function?.name || tc.name,
                input,
              };
            });
            if (toolCalls.length === 0) {
              toolCalls.push(...parseToolCalls(fullContent));
            }
            const cleanContent = cleanVisibleText(fullContent);
            let contentIndex = 0;

            if (cleanContent) {
              writeAnthropicStreamText(anthropicStream, contentIndex, cleanContent);
              contentIndex++;
            }

            for (let i = 0; i < toolCalls.length; i++) {
              writeAnthropicStreamToolCall(anthropicStream, contentIndex + i, toolCalls[i], messageId);
            }

            endAnthropicStream(anthropicStream, toolCalls.length, inputTokens);
          });

          transformed.once('error', () => {
            endAnthropicStream(anthropicStream, 0, inputTokens);
          });

          ctx.status = 200;
          ctx.set('Content-Type', 'text/event-stream');
          ctx.set('Cache-Control', 'no-cache');
          ctx.set('Connection', 'keep-alive');
          ctx.body = anthropicStream;
          return;
        }

        // Non-stream mode
        const nshandler = new QwenAiStreamHandler(internalReq.model);
        const nstransformed = await nshandler.handleStream(response.data);
        const { PassThrough } = require('stream');
        const collector = new PassThrough();
        nstransformed.pipe(collector);

        let resultContent = '';
        const chunks: Buffer[] = [];
        collector.on('data', (chunk: Buffer) => chunks.push(chunk));
        await new Promise<void>((resolve, reject) => {
          collector.once('end', resolve);
          collector.once('error', reject);
        });

        const rawText = Buffer.concat(chunks).toString();
        const dataLines = rawText.split('\n').filter(line => line.startsWith('data: '));
        for (const line of dataLines) {
          try {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) resultContent += delta.content;
          } catch {}
        }

        const toolCalls = parseToolCalls(resultContent);
        const cleanContent = cleanVisibleText(resultContent);
        const outputTokens = Math.max(1, Math.ceil((cleanContent.length + JSON.stringify(toolCalls).length) / 4));

        const anthropicResponse = renderAnthropicNonStream(
          cleanContent,
          toolCalls,
          inputTokens,
          outputTokens,
          internalReq.model,
          messageId,
        );

        ctx.status = 200;
        ctx.set('x-request-id', crypto.randomUUID());

        // Also cache toolCalls in the response for downstream render
        (anthropicResponse as any).toolCalls = toolCalls;
        ctx.body = anthropicResponse;
      } catch (err) {
        ctx.status = 500;
        ctx.body = { error: { message: err instanceof Error ? err.message : String(err) } };
        configStore.addLog('error', JSON.stringify({
          path: '/v1/messages',
          status: 500,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - startedAt,
        }));
      }
    });

    this.router.post('/v1/messages/count_tokens', async ctx => {
      const body = ctx.request.body as any;
      if (!body) {
        ctx.status = 400;
        ctx.body = { error: { message: 'Request body required' } };
        return;
      }

      try {
        const inputTokens = estimateAnthropicInputTokens(body);
        ctx.body = {
          input_tokens: inputTokens,
          output_tokens: 0,
        };
      } catch (err) {
        ctx.status = 500;
        ctx.body = { error: { message: err instanceof Error ? err.message : String(err) } };
      }
    });

    this.app.use(this.router.routes());
    this.app.use(this.router.allowedMethods());
    this.app.use(async ctx => {
      if (ctx.method !== 'GET' || ctx.status !== 404) return;
      const requestPath = ctx.path || '';
      const isApiPath =
        requestPath.startsWith('/api/') ||
        requestPath.startsWith('/v1/') ||
        requestPath.startsWith('/auth/') ||
        requestPath.startsWith('/assets/');
      const hasFileExtension = /\.[a-zA-Z0-9]+$/.test(requestPath);
      if (isApiPath || hasFileExtension || !fs.existsSync(frontendIndex)) return;
      ctx.status = 200;
      ctx.type = 'html';
      ctx.body = fs.createReadStream(frontendIndex);
    });
  }

  async start(port: number = 8080, host: string = '127.0.0.1') {
    if (this.server) return false;
    return new Promise<boolean>(resolve => {
      try {
        this.server = this.app.listen(port, host, () => {
          const addr = this.server && this.server.address && this.server.address();
          let actualPort = port;
          if (addr && typeof addr === 'object' && (addr as any).port) {
            actualPort = (addr as any).port;
          }
          console.log(`qwen-provider proxy listening on ${host}:${actualPort}`);
          resolve(true);
        });

        // No websocket upgrade forwarding required for static UI build.
        this.server.on('error', (err: NodeJS.ErrnoException) => {
          console.error('[SimpleProxyServer] listen error:', err && err.message ? err.message : err);
          this.server = null;
          resolve(false);
        });
      } catch (err) {
        console.error('[SimpleProxyServer] listen threw error:', err);
        this.server = null;
        resolve(false);
      }
    });
  }

  async stop() {
    if (!this.server) return false;
    return new Promise<boolean>(resolve => {
      this.server!.close(err => {
        this.server = null;
        resolve(!err);
      });
    });
  }
}

export const simpleProxyServer = new SimpleProxyServer();

export default simpleProxyServer;
