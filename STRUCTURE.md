# Project Structure

This document maps the current Proxy-Luna codebase and the main ownership boundaries.

```text
Proxy-Luna/
├── README.md                    # Project overview, setup, API notes
├── STRUCTURE.md                 # This directory and module map
├── REPORT_TOOL_CALL_FORMATS.md  # Tool-call protocol notes and compatibility report
├── package.json                 # Root scripts and dependencies
├── tsconfig.json                # Backend TypeScript configuration
├── src/                         # Backend proxy source
├── frontend/                    # React admin UI source
├── public/                      # Built/static UI served by the backend
├── tests/                       # TypeScript behavior tests
├── data/                        # Local runtime state, logs, overflow files
├── lib/                         # TypeScript build output
└── node_modules/                # Installed dependencies
```

`data/`, `lib/`, `node_modules/`, `frontend/dist/`, and `frontend/node_modules/` are generated or local runtime artifacts. They are useful for local debugging but should not be treated as source ownership boundaries.

## Backend Source

```text
src/
├── dev.ts                       # Development entry point
├── index.ts                     # Package export surface
├── server.ts                    # Koa server, API routes, request pipeline
├── configStore.ts               # Persistent config and in-app log storage
├── sessionStore.ts              # Session persistence, file-backed sessions, bindings
├── modules/                     # Server feature modules
├── runtime/                     # Scheduling, locks, routing, worker runtime
├── main/
│   ├── oauth/                   # Qwen credential capture/validation helpers
│   ├── providers/               # Built-in provider definitions
│   ├── proxy/                   # Provider adapters, prompts, tool-call handling
│   └── store/                   # Shared provider/account type definitions
└── types/                       # Local declaration files
```

`src/server.ts` is the integration point. It authenticates requests, resolves providers/accounts/sessions, applies overflow policy, injects tool prompts, routes direct or worker-backed provider calls, transforms streams, and persists run/session metadata.

## Server Modules

```text
src/modules/
├── chatCleanup.ts              # Qwen chat cleanup scheduler and manual cleanup status
├── contextHash.ts              # Context-hash session resolution helpers
├── overflowPolicy.ts            # Overflow file generation, upload, file-backed session anchors
├── ossUploader.ts               # Qwen OSS/file upload helper
├── responseAnalyzer.ts          # Response XML/tool-output inspection helpers
├── rollingSummary.ts            # Async rolling summary generation
├── sessionCompactor.ts          # Session summary/compaction flow
├── sessionPersistence.ts        # Persist user/assistant turns into sessions
├── sseCollector.ts              # Convert streamed OpenAI SSE into final objects
├── textUtils.ts                 # Text extraction and token estimates
├── upstreamErrorHandler.ts      # Normalize upstream/provider error responses
└── workers.ts                   # Worker registry and verification helpers
```

## Runtime Layer

```text
src/runtime/
├── locks.ts                     # Account/provider/session lock management
├── networkProfiles.ts           # Network profile persistence and direct IP verification
├── providerFactory.ts           # Provider adapter construction
├── providerRouter.ts            # Provider/account selection
├── runControllers.ts            # Abort/cancel controller registry
├── runStore.ts                  # Run persistence, delete-one, and clear-all operations
├── scheduler.ts                 # Queueing and concurrency policies
├── types.ts                     # Runtime type definitions
├── workerClient.ts              # Worker forwarding client
└── workerSelector.ts            # Worker selection rules for egress isolation
```

## Qwen Proxy Layer

```text
src/main/proxy/
├── adapters/qwen-ai.ts          # Qwen web chat/file/model adapter and stream transformer
├── anthropic.ts                 # Anthropic-compatible request/response conversion
├── overflowSanitizer.ts         # Overflow sanitization and failure-echo cleanup
├── projectSnapshot.ts           # Project snapshot rendering helper
├── promptToolUse.ts             # Legacy XML tool-use parser helpers
├── providerToolGuard.ts         # Provider tool-output leak guard helpers
├── types.ts                     # Proxy-specific shared types
├── constants/
│   └── signatures.ts            # Tool/protocol signature constants
├── prompt/
│   └── variants/qwen.ts         # Qwen prompt variants
├── prompts/
│   └── prompts.ts               # Runtime-editable prompt definitions and overrides
├── toolcall/
│   ├── toolcall.ts              # ML_XML prompt injection, parsing, cleanup, stream helpers
│   └── types.ts                 # Tool-call type definitions
└── utils/
    ├── streamToolHandler.ts     # Legacy stream tool handler
    ├── toolParser.ts            # Text tool-call parser
    ├── tools.ts                 # Tool prompt rendering utilities
    └── toolParser/index.ts      # Unified parser utilities
```

Tool-call compatibility is split across:

- `toolcall/toolcall.ts` for the ML_XML prompt contract and parser.
- `adapters/qwen-ai.ts` for Qwen stream transformation, including native `function_call` interception.
- `anthropic.ts` and `/v1/messages` in `server.ts` for Anthropic `tool_use` rendering.
- `sseCollector.ts` for non-stream OpenAI-compatible collection.

## Frontend Source

```text
frontend/
├── index.html                   # UI HTML shell
├── README.md                    # UI-specific notes
├── DESIGN_GUIDELINES.md         # Frontend design notes
├── tsconfig.json                # UI TypeScript config
└── src/
    ├── App.tsx                  # App router and shell
    ├── main.tsx                 # React entry point
    ├── styles.css               # UI styling
    ├── components/
    │   └── Layout.tsx           # Shared app layout
    ├── design/
    │   └── tokens.ts            # UI design tokens
    └── pages/
        ├── Dashboard.tsx
        ├── Logs.tsx
        ├── Models.tsx
        ├── NetworkProfiles.tsx
        ├── Providers.tsx
        ├── ProxyPage.tsx
        ├── Runs.tsx
        ├── Sessions.tsx
        └── Settings.tsx
```

The backend serves `public/`, not `frontend/`. `frontend/` is source; `public/` is the built/static UI bundle used at runtime.

Logs, Runs, and Sessions use bounded scroll containers and lazy row rendering in the frontend. Runs and Sessions open selected-item details in an overlay panel instead of appending detail content below long tables.

## Static UI

```text
public/
├── index.html
├── styles.css
└── assets/
    ├── index-D6w6AveW.js
    └── proxy-luna-app.js
```

## Tests

```text
tests/
├── overflowSanitizer.test.ts    # Overflow sanitizer behavior tests
├── providerRouter.test.ts       # Provider/account selection tests
├── runtimeLocks.test.ts         # Lock manager tests
├── runtimeScheduler.test.ts     # Scheduler/concurrency tests
├── sessionStore.test.ts         # Session persistence tests
├── toolcall.test.ts             # Tool prompt/parser/Anthropic/Qwen stream tests
└── utils.ts                     # Minimal test harness helpers
```

## Runtime Data

```text
data/
├── config.json                  # Local config plus application logs
├── sessions.json                # Session history, summaries, provider bindings
├── runs.json                    # Run history
├── compact/                     # Generated compact session summaries
├── overflow/                    # Generated overflow prompt files
└── wire-logs/                   # Provider request/stream wire logs
```

Overflow files are full prompt containers. They are useful for debugging, but large tool results inside them still count against provider-side context/quota once Qwen parses the attached file.
