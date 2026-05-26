import fs from 'fs';
import path from 'path';

export interface ProviderAccountConfig {
  id: string;
  name?: string;
  enabled?: boolean;
  credentials?: Record<string, string>;
  maxConcurrentRuns?: number;
  networkProfileId?: string;
  status?: string;
}

export interface ProviderConfig {
  id: string;
  name?: string;
  credentials?: Record<string, string>;
  accounts?: ProviderAccountConfig[];
  maxConcurrentRuns?: number;
  networkProfileId?: string;
  oauth?: {
    authorizeUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    authorizeParams?: Record<string, string>;
    tokenParamName?: string;
    tokenKey?: string;
  };
}

export interface StoredConfig {
  providers: ProviderConfig[];
  proxy: { host: string; port: number; key?: string };
  models: Array<{ id: string; name: string }>;
  modelsUpdatedAt?: number;
  logs: Array<{ level: string; message: string; timestamp: number }>;
  settings: Record<string, any>;
}

export class ConfigStore {
  private filePath: string;
  private data: StoredConfig;

  constructor() {
    const dataDir = path.join(process.cwd(), 'data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.filePath = path.join(dataDir, 'config.json');
    this.data = this.load();
  }

  private load(): StoredConfig {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(raw) as StoredConfig;
      }
    } catch (err) {
      console.error('Failed to load config:', err);
    }

    const defaultConfig: StoredConfig = {
      providers: [
        {
          id: 'qwen-ai',
          name: 'Qwen AI (International)',
          credentials: {},
        },
      ],
      proxy: { host: '127.0.0.1', port: 8080, key: '' },
      models: [],
      logs: [],
      settings: {},
    };

    defaultConfig.settings = {
      tokenOverflow: {
        enabled: true,
        threshold: 10000,
        sanitizer: {
          enabled: true,
          mode: 'generic-plus-client-rules',
          preserveRawDebugFile: false,
          maxEnvironmentFileList: 200,
          maxMessageChars: 20000,
          stripClientToolProtocol: true,
          stripAutomatedClientErrors: true,
          stripAssistantToolFailureEcho: true,
          stripAssistantThinking: true,
          dedupeAssistantMessages: true,
          assistantSimilarityThreshold: 0.85,
          assistantDedupeMode: 'normalized-token-jaccard',
          assistantKeepStrategy: 'latest-clean',
          stripAssistantContainerConfusion: true,
          maxAssistantMessages: 1,
          maxToolResultChars: 12000,
          maxToolResultCount: 5,
          prioritizeUserMessages: true,
          includeProjectSnapshot: true,
        },
      },
      session: {
        enabled: true,
        historyLimit: 10,
        rollingHistoryK: 10,
        summaryEveryNTurns: 5,
        summaryMaxTokens: 800,
        summaryInputMaxTokens: 6000,
        summaryMessageMaxChars: 3000,
        summaryIncludeSystemMessages: false,
        autoCompact: true,
        compactAfterMessages: 40,
        compactModel: 'Qwen3.6-Plus',
        compactKeepRecent: 5,
        overflowSignal: {
          enabled: true,
          mode: 'auto',
          signalThresholdTokens: 90000,
        },
        chatCleanup: {
          enabled: false,
          afterResponse: false,
          scheduled: {
            enabled: false,
            mode: 'proxy-created',
            intervalHours: 1,
            maxAgeHours: 24,
          },
        },
      },
      multiThread: {
        enabled: true,
        globalMaxConcurrentRuns: 20,
        defaultProviderMaxConcurrentRuns: 5,
        defaultAccountMaxConcurrentRuns: 2,
        sameProviderChatPolicy: 'queue',
        sameSessionWritePolicy: 'serialize',
        queueTimeoutMs: 120000,
        runTimeoutMs: 300000,
        subagentMode: 'parallel-safe',
      },
      egressIsolation: {
        enabled: false,
        mode: 'worker',
        strict: true,
        fallbackToDirect: false,
        verifyBeforeUse: true,
        verifyIpUrl: 'https://api.ipify.org?format=json',
      },
      tokenLimits: {
        enabled: true,
        maxInputTokens: 128000,
        warnInputTokens: 100000,
        defaultMaxOutputTokens: 8192,
        maxOutputTokensCap: 32000,
      },
      ui: {
        language: 'en',
      },
    };

    this.save(defaultConfig);
    return defaultConfig;
  }

  private save(data?: StoredConfig) {
    try {
      const toSave = data ?? this.data;
      fs.writeFileSync(this.filePath, JSON.stringify(toSave, null, 2), 'utf8');
      this.data = toSave;
    } catch (err) {
      console.error('Failed to save config:', err);
    }
  }

  getConfig() {
    return this.data;
  }

  updateConfig(partial: Partial<StoredConfig>) {
    if (partial.settings && typeof partial.settings === 'object') {
      this.data.settings = {
        ...(this.data.settings || {}),
        ...partial.settings,
        tokenOverflow: {
          ...(this.data.settings?.tokenOverflow || {}),
          ...(partial.settings.tokenOverflow || {}),
          sanitizer: {
            ...((this.data.settings?.tokenOverflow as any)?.sanitizer || {}),
            ...((partial.settings.tokenOverflow as any)?.sanitizer || {}),
          },
        },
        session: {
          ...(this.data.settings?.session || {}),
          ...(partial.settings.session || {}),
          overflowSignal: {
            ...((this.data.settings?.session as any)?.overflowSignal || {}),
            ...((partial.settings.session as any)?.overflowSignal || {}),
          },
          chatCleanup: {
            ...((this.data.settings?.session as any)?.chatCleanup || {}),
            ...((partial.settings.session as any)?.chatCleanup || {}),
            scheduled: {
              ...((this.data.settings?.session as any)?.chatCleanup?.scheduled || {}),
              ...((partial.settings.session as any)?.chatCleanup?.scheduled || {}),
            },
          },
        },
        multiThread: {
          ...((this.data.settings?.multiThread as any) || {}),
          ...((partial.settings.multiThread as any) || {}),
        },
        egressIsolation: {
          ...((this.data.settings?.egressIsolation as any) || {}),
          ...((partial.settings.egressIsolation as any) || {}),
        },
        tokenLimits: {
          ...((this.data.settings?.tokenLimits as any) || {}),
          ...((partial.settings.tokenLimits as any) || {}),
        },
        ui: {
          ...((this.data.settings?.ui as any) || {}),
          ...((partial.settings.ui as any) || {}),
        },
      };
      const rest = {...partial};
      delete (rest as any).settings;
      this.data = {...this.data, ...(rest as any)};
    } else {
      this.data = {...this.data, ...(partial as any)};
    }
    this.save();
    return this.data;
  }

  setProviderToken(providerId: string, tokenKey: string, tokenValue: string) {
    const p = this.data.providers.find(x => x.id === providerId);
    if (!p) {
      this.data.providers.push({ id: providerId, credentials: { [tokenKey]: tokenValue } });
    } else {
      p.credentials = { ...(p.credentials || {}), [tokenKey]: tokenValue };
    }
    this.save();
  }

  setProviderName(providerId: string, name: string) {
    const p = this.data.providers.find(x => x.id === providerId);
    if (p) {
      p.name = name;
      this.save();
    }
  }

  setProviderOAuthConfig(providerId: string, oauthConfig: any) {
    const p = this.data.providers.find(x => x.id === providerId);
    if (!p) {
      this.data.providers.push({ id: providerId, oauth: oauthConfig });
    } else {
      p.oauth = { ...(p.oauth || {}), ...(oauthConfig || {}) };
    }
    this.save();
  }

  getProviderOAuthConfig(providerId: string) {
    const p = this.data.providers.find(x => x.id === providerId);
    return p?.oauth ?? null;
  }

  getModels() {
    return this.data.models;
  }

  addModel(model: { id: string; name: string }) {
    this.data.models.push(model);
    this.save();
    return this.data.models;
  }

  setModels(models: Array<{ id: string; name: string }>) {
    this.data = {
      ...this.data,
      models: [...models],
      modelsUpdatedAt: Date.now(),
    };
    this.save();
    return this.data.models;
  }

  addLog(level: string, message: string) {
    this.data.logs.push({ level, message, timestamp: Date.now() });
    // keep logs bounded
    if (this.data.logs.length > 1000) this.data.logs.shift();
    this.save();
  }

  getLogs(limit = 200) {
    return this.data.logs.slice(-limit).reverse();
  }

  getLogsStats() {
    const total = this.data.logs.length;
    const errors = this.data.logs.filter(l => l.level === 'error').length;
    const chatRequests = this.data.logs.filter(l => {
      try {
        const parsed = JSON.parse(l.message);
        return parsed.path === '/v1/chat/completions';
      } catch {
        return false;
      }
    }).length;
    return { total, errors, chatRequests };
  }

  clearLogs() {
    this.data.logs = [];
    this.save();
  }
}

export const configStore = new ConfigStore();

export default configStore;
