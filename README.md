# Proxy-Luna

Proxy-Luna is a standalone local proxy for Qwen web/API workflows. It exposes an
OpenAI-compatible `/v1/chat/completions` endpoint, forwards requests to Qwen,
serves a local admin UI, and keeps local state for providers, accounts, sessions,
runs, overflow files, and logs.

The proxy is designed for local development and controlled routing. Runtime data
is stored on disk under `data/`.

## Features

- OpenAI-compatible chat endpoint at `/v1/chat/completions`.
- Streaming and non-streaming chat responses.
- Qwen account and credential management.
- Admin UI served from the same host and port as the API.
- Session persistence, provider-session binding, and run tracking.
- Queueing and concurrency controls for providers, accounts, and workers.
- Prompt overflow handling through file-backed context.
- Optional worker routing and egress/IP verification.
- Local logs and diagnostics APIs.

## Requirements

- Bun for the default development workflow.
- Node.js/npm for TypeScript checks and builds.
- Qwen credentials, either configured through the UI/API or environment
  variables.

## Quick Start

```bash
bun install
bun run dev
```

Open the admin UI:

```text
http://127.0.0.1:8080/
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Configuration

The default proxy address is:

```text
127.0.0.1:8080
```

Local configuration is stored in:

```text
data/config.json
```

You can configure credentials from the admin UI or by API:

```bash
curl -X POST http://127.0.0.1:8080/api/provider/token \
  -H 'Content-Type: application/json' \
  -d '{
    "providerId": "qwen-ai",
    "credentials": {
      "token": "YOUR_QWEN_TOKEN",
      "cookies": "YOUR_QWEN_COOKIES"
    }
  }'
```

The server also checks these environment variables as fallback credentials:

```text
QWEN_AI_TOKEN
QWEN_AI_COOKIES
```

If `proxy.key` is set in `data/config.json`, requests to
`/v1/chat/completions` must include either:

```text
Authorization: Bearer <proxy-key>
```

or:

```text
x-proxy-key: <proxy-key>
```

## Chat API

Endpoint:

```text
POST /v1/chat/completions
```

Minimal non-streaming request:

```bash
curl -sS -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3.6-Plus",
    "stream": false,
    "messages": [
      {"role": "user", "content": "Xin chào"}
    ]
  }'
```

Streaming request:

```bash
curl -N -sS -X POST http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "Qwen3.6-Plus",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Viết một đoạn giới thiệu ngắn"}
    ]
  }'
```

Common request fields:

- `model`: Qwen model name or mapped model id.
- `messages`: OpenAI-style messages.
- `stream`: `true` for SSE streaming, `false` for a collected response.
- `account`: optional preferred provider account id.
- `session_id`: optional Proxy-Luna session id.
- `providerSessionId` or `provider_session_id`: optional upstream Qwen chat id.
- `file_ids`: optional uploaded Qwen file ids.
- `thinking_mode`, `reasoning_effort`, `enable_thinking`, `thinking_budget`:
  optional Qwen thinking controls.

Useful session headers:

```text
x-luna-session-id
x-luna-source
x-luna-workspace
x-luna-thread-id
x-luna-provider-session-id
x-luna-account-id
```

When a session is resolved, response headers may include:

```text
x-luna-session-id
x-luna-thread-id
x-luna-provider-session-id
```

## Prompt Overflow

Proxy-Luna estimates prompt size before sending requests upstream. When the
configured token threshold is exceeded, the full client prompt is written to an
overflow file under:

```text
data/overflow/
```

The proxy then sends a short transport prompt plus the uploaded overflow file to
Qwen. The file is treated as the primary conversation/prompt, not as reference
material. Task routing and output format remain the responsibility of the prompt
inside the file.

Default overflow settings live in `data/config.json` under:

```text
settings.tokenOverflow
```

## Sessions And Runs

Proxy-Luna stores local session and run state:

```text
data/sessions.json
data/runs.json
```

Session behavior is configured under:

```text
settings.session
```

Runtime queueing and concurrency behavior is configured under:

```text
settings.multiThread
```

The admin UI includes pages for inspecting sessions, runs, logs, providers,
models, and network workers.

## Admin And Diagnostic APIs

Common endpoints:

```text
GET    /health
GET    /api/config
POST   /api/config
GET    /api/models
POST   /api/models/refresh
GET    /api/logs
DELETE /api/logs
GET    /api/sessions
GET    /api/runs
GET    /api/runtime
GET    /api/provider-runtime
GET    /api/network-profiles
GET    /api/workers
```

Debug endpoints are available under:

```text
/api/debug/qwen-roundtrip
/api/debug/qwen-wire
/api/debug/qwen-file-flow
```

## Development Commands

```bash
bun run dev
npm run dev
npm run typecheck
npm run build
npm run dev:watch
```

`bun run dev` and `npm run dev` both run:

```text
bun ./src/dev.ts
```

TypeScript build output is written to:

```text
lib/
```

## Frontend Source And Static UI

The frontend source lives in:

```text
frontend/
```

The backend does not serve `frontend/` directly. It serves the built/static UI
from:

```text
public/
```

This keeps the proxy runtime easy to read:

- `src/` is the backend proxy.
- `frontend/` is the React admin UI source.
- `public/` is the static UI currently served by Koa.

## Project Structure

See [STRUCTURE.md](./STRUCTURE.md) for the directory map and module ownership
notes.

Important directories:

```text
src/        backend proxy source
frontend/   React admin UI source
public/     built/static UI served by the backend
tests/      TypeScript tests
scripts/    local helper scripts
data/       local runtime state and logs
lib/        TypeScript build output
```

`tests/` contains source tests for the backend modules. It is intentionally kept
as project source, not treated as runtime output.

## Troubleshooting

No credentials:

```text
Token/cookies not configured
```

Configure Qwen credentials in the UI or through `/api/provider/token`.

Unauthorized:

```text
Unauthorized: invalid proxy key
```

Pass the configured proxy key through `Authorization: Bearer ...` or
`x-proxy-key`.

Queue timeout:

```text
Scheduler queue timeout
```

Check active runs, account concurrency limits, worker availability, and runtime
settings in the admin UI.

File or overflow failures:

Check:

```text
data/overflow/
data/wire-logs/
data/config.json
```

Provider stream issues:

Use the Logs and Runs pages in the UI, or inspect:

```text
GET /api/logs
GET /api/runs
```

## Important Notice

**WARNING: This project is provided only for research, learning, and local
technical evaluation. It is not intended for commercial use, production abuse,
unauthorized access, policy bypassing, spam, credential misuse, service abuse,
or any other harmful activity. Any misuse of this project is strictly
prohibited. Users are responsible for complying with applicable laws, platform
terms, and provider policies.**
