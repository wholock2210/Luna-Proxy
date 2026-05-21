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
- **Anthropic-compatible API** — `/v1/messages` and `/v1/messages/count_tokens` for Claude-style clients
- **Streaming support** — SSE streaming and non-streaming responses
- **Tool-call bridging** — injects an XML tool contract for Qwen, parses tool calls, and returns OpenAI `tool_calls` or Anthropic `tool_use`
- **Built-in Admin UI** — React dashboard served alongside the API on the same port
- **Credential management** — automatic OAuth capture via Puppeteer or manual token/cookie input
- **Multi-account routing** — queue and concurrency controls across providers, accounts, and workers
- **Session & run tracking** — persistent sessions, run history, thread binding, and admin cleanup controls
- **Prompt overflow handling** — automatically offloads large prompts to file-backed context
- **Runtime prompt overrides** — inspect and update protocol prompts from the admin API
- **Worker routing** — optional egress/IP verification and worker forwarding
- **Diagnostics APIs** — built-in logs, runtime inspection, and debug roundtrip endpoints

---

## Requirements

- [Node.js](https://nodejs.org) 18+ (for npm/pnpm/bun compatibility)
- One package manager: [npm](https://www.npmjs.com), [pnpm](https://pnpm.io), or [Bun](https://bun.sh)
- Qwen credentials — configured via the admin UI or environment variables
- Chrome / Chromium — only needed for the automatic OAuth capture flow

---

## Quick Start

Choose one package manager:

```bash
# npm
npm install
npm run dev
```

```bash
# pnpm
pnpm install
pnpm run dev
```

```bash
# bun
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

LunaProxy exposes the built-in Qwen model catalog through the `/v1/models` endpoint in OpenAI-compatible format. The model list is maintained in `src/main/providers/builtin/qwen-ai.ts` and is the single source used by `/api/models`, `/api/models/refresh`, and `/v1/models`.

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

The **Models** page can refresh/sync the runtime config from this built-in catalog via `POST /api/models/refresh`; it does not fetch a separate model list from Qwen at runtime.

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
# npm
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium npm run dev

# pnpm
PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium pnpm run dev

# bun
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
| `tools` | array | *(optional)* OpenAI-style tool definitions |
| `tool_choice` | string/object | *(optional)* `auto`, `none`, `required`, or a specific function |

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

## Anthropic API

**Endpoint:** `POST /v1/messages`

This endpoint accepts Anthropic-style `system`, `messages`, `tools`, and `tool_choice` fields, converts them to the internal chat format, routes the request through Qwen, then renders the response back as Anthropic-compatible content blocks.

```bash
curl -N -sS -X POST http://127.0.0.1:8080/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "qwen3.6-plus",
    "max_tokens": 1024,
    "stream": true,
    "messages": [
      {"role": "user", "content": "Read the project README and summarize it"}
    ],
    "tools": [
      {
        "name": "Read",
        "description": "Read a local file",
        "input_schema": {
          "type": "object",
          "properties": {
            "file_path": {"type": "string"}
          },
          "required": ["file_path"]
        }
      }
    ]
  }'
```

`POST /v1/messages/count_tokens` returns a local estimate. It does not call Qwen.

---

## Tool Calling

Qwen web chat does not provide the same local tool runtime as clients such as Claude Code or Cline. LunaProxy bridges that gap at the protocol layer:

1. The client sends OpenAI `tools` or Anthropic `tools`.
2. LunaProxy injects a strict ML_XML tool-call contract into the prompt.
3. If Qwen emits `<ml_tool_calls>...</ml_tool_calls>`, LunaProxy parses it.
4. If Qwen emits native `function_call` deltas, LunaProxy intercepts them before Qwen's own web backend can leak `Tool ... does not exists.`
5. LunaProxy returns standard OpenAI `tool_calls` or Anthropic `tool_use` blocks to the client.
6. The client executes the tool and sends the result back in the next request.

LunaProxy does not execute `Read`, `Bash`, `Edit`, or other client tools itself. It only translates model output into the client protocol. A client without tool execution support will still need its own executor.

The tool prompt defaults live in:

```
src/main/proxy/prompts/prompts.ts
src/main/proxy/toolcall/toolcall.ts
```

Runtime prompt overrides are available through `GET /api/prompts`, `POST /api/prompts`, and `POST /api/prompts/reset`.

---

## Prompt Overflow

When a prompt exceeds the configured token threshold, LunaProxy writes the full prompt to an overflow file and sends a compact transport prompt + the file to Qwen instead. The file is treated as the primary conversation context, not as a reference attachment.

Overflow files are stored at:

```
data/overflow/
```

Default overflow settings are configured in `data/config.json` under `settings.tokenOverflow`.

The `TOTAL_TOKENS` value written into an overflow file is local debug metadata. It is not sent to Qwen as an API parameter and changing it does not change provider-side token accounting. Qwen still parses and tokenizes the attached file content. Very large tool results or session histories can still trigger provider errors such as `Allocated quota exceeded` even if the advertised model context window is larger.

When debugging overflow problems, inspect:

```
data/overflow/
data/wire-logs/
data/config.json
```

If overflow files keep growing, reduce retained session history, compact old tool results, or avoid persisting large file reads as full prompt history.

---

## Sessions & Runs

LunaProxy persists session and run state to disk:

```
data/sessions.json   # session history and provider bindings
data/runs.json       # run history
```

Session behavior is configured under `settings.session`. Concurrency and queueing behavior is under `settings.multiThread`.

The admin UI includes dedicated pages for browsing sessions, runs, logs, providers, models, and workers. Logs, Runs, and Sessions render lazily in batches while you scroll, so long histories do not block the UI. Session and run detail views open in an overlay panel, similar to the Logs detail view, so selecting an item does not require scrolling past a long table.

Cleanup controls:

- Logs can be cleared from the Logs page or with `DELETE /api/logs`.
- Runs can be deleted individually or all at once from the Runs page.
- Sessions can be deleted individually or all at once from the Sessions page.

Overflow and compact artifacts are preserved locally for debugging:

```
data/overflow/   # full prompt overflow files
data/compact/    # compact-session source files
```

If Qwen file upload or parse-status polling fails during overflow, LunaProxy falls back to the original request messages instead of sending a fake attachment prompt. If compact upload fails, the local compact file is kept and compaction is skipped.

---

## API Reference

### Core endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completions |
| `POST` | `/v1/messages` | Anthropic-compatible messages |
| `POST` | `/v1/messages/count_tokens` | Anthropic-compatible token estimate |

### Admin & config

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/config` | Read current config |
| `POST` | `/api/config` | Update config |
| `GET` | `/api/prompts` | List runtime prompt definitions and overrides |
| `POST` | `/api/prompts` | Set a prompt override |
| `POST` | `/api/prompts/reset` | Reset prompt overrides |
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
| `GET` | `/api/sessions/:id` | Get session detail |
| `DELETE` | `/api/sessions/:id` | Delete one session |
| `DELETE` | `/api/sessions` | Delete all sessions |
| `POST` | `/api/sessions/:id/clear` | Clear one session's history |
| `POST` | `/api/sessions/:id/compact` | Compact one session |
| `POST` | `/api/sessions/:id/rename` | Rename one session |
| `POST` | `/api/sessions/:id/reset-provider` | Reset provider chat binding |
| `POST` | `/api/sessions/reload` | Reload sessions from disk |
| `GET` | `/api/runs` | List runs |
| `GET` | `/api/runs/:id` | Get run detail |
| `POST` | `/api/runs/:id/cancel` | Cancel an active run |
| `DELETE` | `/api/runs/:id` | Delete one run |
| `DELETE` | `/api/runs` | Delete all runs |
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
├── data/                 # Runtime state, logs, overflow files (generated)
└── lib/                  # TypeScript build output (generated)
```

> See [STRUCTURE.md](./STRUCTURE.md) for the full directory map and module ownership notes.

---

## Development

```bash
# Start dev server
npm run dev
# or
pnpm run dev
# or
bun run dev

# Watch mode
npm run dev:watch
# or
pnpm run dev:watch
# or
bun run dev:watch

# Type check
npm run typecheck
# or
pnpm run typecheck
# or
bun run typecheck

# Build
npm run build
# or
pnpm run build
# or
bun run build
```

`npm run dev`, `pnpm run dev`, and `bun run dev` all execute `bun ./src/dev.ts`. TypeScript build output goes to `lib/`.

Run the focused tool-call suite with:

```bash
npx ts-node tests/toolcall.test.ts
```

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

**`Allocated quota exceeded` from Qwen**
The provider rejected the effective prompt allocation. This can happen when overflow files contain very large histories or tool results. The local `TOTAL_TOKENS` line in the overflow file is only metadata; reduce the actual prompt/file content instead.

**`Tool ... does not exists` in provider logs**
Qwen may emit native `function_call` deltas and then its web backend may report missing tools. LunaProxy intercepts that pattern in the stream transformer and returns client-compatible tool calls. If the text reaches the client, restart the dev server and inspect `data/wire-logs/` plus `tests/toolcall.test.ts`.

**Stream issues**
Check the **Logs** and **Runs** pages in the admin UI, or query `GET /api/logs` and `GET /api/runs` directly.
