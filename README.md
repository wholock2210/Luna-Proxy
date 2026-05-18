# LunaProxy



LunaProxy is a local reverse proxy that exposes Qwen's web chat as a fully OpenAI-compatible API. It handles credential management, multi-account concurrency, session persistence, and prompt overflow — all from a single process with a built-in React admin UI served on the same port.
Designed for local development and controlled routing. No cloud dependency, no third-party relay — just a direct bridge between your OpenAI-compatible tooling and Qwen.

---

> [!WARNING]
>  # **Disclaimer**
>
> This repository is provided for learning, research, personal experimentation, and internal validation only. It does not grant any commercial authorization and comes with no warranty of fitness, stability, or results.
>
> The author and repository maintainers are not responsible for any direct or indirect loss, account suspension, data loss, legal risk, or third-party claims arising from use, modification, distribution, deployment, or reliance on this project.

---

## Features

- **OpenAI-compatible API** — drop-in `/v1/chat/completions` and `/v1/models` endpoints
- **Streaming support** — SSE streaming and non-streaming responses
- **Built-in Admin UI** — React dashboard served alongside the API on the same port
- **Credential management** — automatic OAuth capture via Puppeteer or manual token/cookie input
- **Multi-account routing** — queue and concurrency controls across providers, accounts, and workers
- **Session & run tracking** — persistent sessions, run history, and thread binding
- **Prompt overflow handling** — automatically offloads large prompts to file-backed context
- **Worker routing** — optional egress/IP verification and worker forwarding
- **Diagnostics APIs** — built-in logs, runtime inspection, and debug roundtrip endpoints

---

## Requirements

- [Bun](https://bun.sh) — primary runtime and dev workflow
- [Node.js](https://nodejs.org) / npm — for TypeScript checks and production builds
- Qwen credentials — configured via the admin UI or environment variables
- Chrome / Chromium — only needed for the automatic OAuth capture flow

---

## Quick Start

```bash
bun install
bun run dev
```

Open the admin UI at `http://127.0.0.1:8080/`, then go to **Providers** and configure your Qwen credentials.

Health check:

```bash
curl http://127.0.0.1:8080/health
```

---

## Configuration

The proxy listens on `127.0.0.1:8080` by default. All runtime configuration is stored at:

```
data/config.json
```

---

## Supported Models

LunaProxy exposes all models configured in the admin UI through the `/v1/models` endpoint in OpenAI-compatible format.

```bash
curl -sS http://127.0.0.1:8080/v1/models
```

Example response:

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen3.6-plus",
      "object": "model",
      "created": 0,
      "owned_by": "qwen-ai",
      "name": "Qwen3.6 Plus"
    }
  ]
}
```

The model list is managed from the **Models** page in the admin UI and can be refreshed via `POST /api/models/refresh`.

---

## Credentials

LunaProxy supports two ways to configure Qwen credentials.

### Automatic OAuth Capture

Opens a real browser window, captures the Qwen web token and cookies after you log in, and saves them automatically.

**Requirements:** Chrome or Chromium must be installed. Access to `https://chat.qwen.ai` is required.

From the admin UI:

1. Open `http://127.0.0.1:8080/`
2. Go to **Providers → qwen-ai → OAuth tab**
3. Click **Start OAuth** and log in to Qwen in the browser window
4. Wait for LunaProxy to capture and save the credentials

Equivalent API call:

```bash
curl -X POST http://127.0.0.1:8080/api/provider/oauth/capture \
  -H 'Content-Type: application/json' \
  -d '{"providerId": "qwen-ai", "timeout": 300000}'
```

If the browser is not found automatically, set the path explicitly:

```bash
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium bun run dev
```

### Manual Token & Cookie Input

Use this when you already have a valid Qwen token and cookie header.

From the admin UI:

1. Go to **Providers → qwen-ai → Config tab**
2. Paste your token and cookie header
3. Click **Validate**, then **Save**

Via API:

```bash
# Set credentials
curl -X POST http://127.0.0.1:8080/api/provider/token \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "qwen-ai",
    "credentials": {
      "token": "YOUR_QWEN_TOKEN",
      "cookies": "YOUR_QWEN_COOKIES"
    }
  }'

# Validate credentials
curl -X POST http://127.0.0.1:8080/api/provider/validate \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "qwen-ai",
    "credentials": {
      "token": "YOUR_QWEN_TOKEN",
      "cookies": "YOUR_QWEN_COOKIES"
    }
  }'

# Check provider status
curl 'http://127.0.0.1:8080/api/provider/status?providerId=qwen-ai'
```

### Environment Variables

LunaProxy also reads credentials from environment variables as a fallback:

```
QWEN_AI_TOKEN
QWEN_AI_COOKIES
```

### Proxy Key Authentication

If `proxy.key` is set in `data/config.json`, all requests to `/v1/chat/completions` and `/v1/models` must include the key via either:

```
Authorization: Bearer <proxy-key>
```

or:

```
x-proxy-key: <proxy-key>
```

---

## Chat API

**Endpoint:** `POST /v1/chat/completions`

### Non-streaming request

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.6-plus",
    "stream": false,
    "messages": [
      {"role": "user", "content": "Hello!"}
    ]
  }'
```

### Streaming request

```bash
curl -N -sS -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.6-plus",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Write a short introduction"}
    ]
  }'
```

### Request fields

| Field | Type | Description |
|---|---|---|
| `model` | string | Qwen model name or mapped model ID |
| `messages` | array | OpenAI-style message array |
| `stream` | boolean | `true` for SSE streaming, `false` for collected response |
| `account` | string | *(optional)* Preferred provider account ID |
| `session_id` | string | *(optional)* LunaProxy session ID |
| `providerSessionId` | string | *(optional)* Upstream Qwen chat ID |
| `file_ids` | array | *(optional)* Pre-uploaded Qwen file IDs |
| `thinking_mode` | string | *(optional)* Qwen thinking mode |
| `reasoning_effort` | string | *(optional)* Reasoning effort level |
| `enable_thinking` | boolean | *(optional)* Enable thinking mode |
| `thinking_budget` | number | *(optional)* Token budget for thinking |

### Session headers

Useful request headers:

```
x-luna-session-id
x-luna-source
x-luna-workspace
x-luna-thread-id
x-luna-provider-session-id
x-luna-account-id
```

Response headers (when a session is resolved):

```
x-luna-session-id
x-luna-thread-id
x-luna-provider-session-id
```

---

## Prompt Overflow

When a prompt exceeds the configured token threshold, LunaProxy writes the full prompt to an overflow file and sends a compact transport prompt + the file to Qwen instead. The file is treated as the primary conversation context, not as a reference attachment.

Overflow files are stored at:

```
data/overflow/
```

Default overflow settings are configured in `data/config.json` under `settings.tokenOverflow`.

---

## Sessions & Runs

LunaProxy persists session and run state to disk:

```
data/sessions.json   # session history and provider bindings
data/runs.json       # run history
```

Session behavior is configured under `settings.session`. Concurrency and queueing behavior is under `settings.multiThread`.

The admin UI includes dedicated pages for browsing sessions, runs, logs, providers, models, and workers.

---

## API Reference

### Core endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions |

### Admin & config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Read current config |
| `POST` | `/api/config` | Update config |
| `GET` | `/api/models` | List models |
| `POST` | `/api/models/refresh` | Refresh model list from provider |

### Provider management

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/provider/token` | Set provider credentials |
| `POST` | `/api/provider/validate` | Validate credentials |
| `GET` | `/api/provider/status` | Get provider status |
| `POST` | `/api/provider/oauth/capture` | Start OAuth capture flow |

### Runtime & diagnostics

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/logs` | Fetch logs |
| `DELETE` | `/api/logs` | Clear logs |
| `GET` | `/api/sessions` | List sessions |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runtime` | Runtime state |
| `GET` | `/api/provider-runtime` | Provider runtime state |
| `GET` | `/api/network-profiles` | Network profiles |
| `GET` | `/api/workers` | Worker list |

### Debug endpoints

```
GET /api/debug/qwen-roundtrip
GET /api/debug/qwen-wire
GET /api/debug/qwen-file-flow
```

---

## Project Structure

```
LunaProxy/
├── src/                  # Backend proxy source (Koa, scheduler, adapters)
│   ├── server.ts         # Main Koa server and API routes
│   ├── configStore.ts    # Config and log persistence
│   ├── sessionStore.ts   # Session persistence and bindings
│   ├── modules/          # Overflow, session, stream, worker modules
│   ├── runtime/          # Scheduler, locks, routing, run tracking
│   └── main/             # OAuth, provider definitions, Qwen adapter
├── frontend/             # React admin UI source
├── public/               # Built static UI served by the backend
├── tests/                # TypeScript tests
├── scripts/              # Local helper scripts
├── data/                 # Runtime state, logs, overflow files (generated)
└── lib/                  # TypeScript build output (generated)
```

> See [STRUCTURE.md](./STRUCTURE.md) for the full directory map and module ownership notes.

---

## Development

```bash
# Start dev server
bun run dev

# Watch mode
npm run dev:watch

# Type check
npm run typecheck

# Build
npm run build
```

Both `bun run dev` and `npm run dev` execute `bun ./src/dev.ts`. TypeScript build output goes to `lib/`.

The frontend source lives in `frontend/`. The backend serves the pre-built static UI from `public/`. To rebuild the UI, run the frontend build separately and copy the output to `public/`.

---

## Troubleshooting

**`Token/cookies not configured`**
Configure Qwen credentials via the admin UI or `POST /api/provider/token`.

**`Unauthorized: invalid proxy key`**
Pass the configured proxy key via `Authorization: Bearer <key>` or the `x-proxy-key` header.

**`Scheduler queue timeout`**
Check active runs, account concurrency limits, and worker availability in the admin UI under **Runs** and **Runtime**.

**Overflow or file upload failures**
Inspect `data/overflow/`, `data/wire-logs/`, and `data/config.json`. Use the debug endpoints for deeper inspection.

**Stream issues**
Check the **Logs** and **Runs** pages in the admin UI, or query `GET /api/logs` and `GET /api/runs` directly.
