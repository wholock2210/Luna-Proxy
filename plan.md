# Session Redesign Plan — Proxy-Luna

## Trạng Thái Triển Khai Hiện Tại

Các phần dưới đây đã được triển khai trong codebase hiện tại:

- ✅ Context hash session resolution qua `src/modules/contextHash.ts` và `sessionStore.contextHashIndex`
- ✅ Rolling summary async qua `src/modules/rollingSummary.ts`
- ✅ Context overflow signal trong request pipeline
- ✅ Chat cleanup scheduler qua `src/modules/chatCleanup.ts`
- ✅ Compact race guard trong `src/modules/sessionPersistence.ts`
- ✅ Compact upload fallback: nếu upload/parse compact file thất bại thì giữ file local trong `data/compact/` và bỏ qua compact thay vì làm hỏng request nền
- ✅ Overflow upload fallback: nếu không attach được overflow file lên Qwen thì không gửi prompt `ATTACHED FILE` giả; request quay lại messages gốc để tránh yêu cầu model đọc file không tồn tại
- ✅ Qwen file parse wait tăng thời gian chờ mặc định trong `src/modules/ossUploader.ts`
- ✅ Run management API: `DELETE /api/runs/:id` và `DELETE /api/runs`
- ✅ Admin UI Sessions/Runs detail mở dạng overlay như Logs, không bị đẩy xuống dưới list dài
- ✅ Admin UI lazy render cho Logs/Runs/Sessions: render batch 50 dòng và tăng dần khi scroll
- ✅ Static UI đã build ra `public/assets/proxy-luna-app.js` và `public/styles.css`

Ghi chú triển khai:

- `frontend/` là source UI; runtime backend serve `public/`.
- `data/sessions.json`, `data/runs.json`, `data/overflow/`, `data/compact/`, và `data/wire-logs/` vẫn là runtime artifacts.
- Overflow file-backed anchor vẫn được giữ để debug/session trace khi overflow xảy ra; nếu upload fail thì anchor chỉ có local path.

## Mục Tiêu

Tái thiết kế hoàn toàn hệ thống session để hoạt động tự động với bất kỳ client chuẩn nào
(Claude Code, Cline, OpenAI SDK...) mà **không cần client gửi custom headers**.

Kết hợp 4 tính năng:

1. **Context Hash Resolution** — nhận diện session tự động qua nội dung messages
2. **Rolling Summary Injection** — giảm prompt size, chống context overflow
3. **Context Overflow Signal** — thông báo client khi context tràn
4. **Chat Cleanup** — xóa Qwen AI chat sau response hoặc theo lịch

---

## Quyết Định Đã Xác Nhận

- ✅ Xóa hoàn toàn logic header cũ (`x-luna-thread-id`, `requireExplicitId`, `fallbackMode`)
- ✅ Giữ hash sau compact — session continuity không bị phá vỡ khi compact xảy ra
- ✅ `messages.length === 1` (first turn) → tạo session mới, index sau response
- ✅ Rolling Summary là cơ chế chính thay vì delta-only Layer 1
- ✅ Model summarize: dùng provider đang cấu hình, không hardcode

---

## Feature 1 — Context Hash Session Resolution

### Nguyên lý

```
Client gửi turn N: [m1, m2, ..., m(N-1)_asst, mN_user]

inboundHash  = SHA-256(m1 .. m(N-1)_asst)   ← lịch sử đã biết
outboundHash = SHA-256(m1 .. mN_asst)        ← sau khi có response

contextHashIndex: { hash → sessionId }

Lookup inboundHash:
  HIT  → currentSession = found   → sessionMode = 'persistent'
  MISS → createSession()          → sessionMode = 'new'

Sau response:
  xóa inboundHash → thêm outboundHash → sessionId
```

**2 client khác nhau tự nhiên cô lập:** Conversations khác nhau → hash khác nhau → sessions riêng biệt.

**Sau compact:** Hash không bị xóa → inboundHash của turn tiếp vẫn khớp outboundHash cũ → session continuity giữ nguyên.

### Files

#### [NEW] `src/modules/contextHash.ts`

```typescript
import crypto from 'crypto';

export function computeInboundContextHash(messages: any[], model: string): string {
  if (!messages || messages.length <= 1) return '';
  const history = messages.slice(0, -1); // bỏ message cuối — user input mới
  return hashMessages(history, model);
}

export function computeOutboundContextHash(
  messages: any[],
  responseText: string,
  model: string,
): string {
  return hashMessages(
    [...messages, { role: 'assistant', content: responseText }],
    model,
  );
}

function hashMessages(messages: any[], model: string): string {
  const parts = messages.map(m => {
    const role = String(m?.role || '').toLowerCase();
    const content = typeof m?.content === 'string'
      ? m.content
      : JSON.stringify(m?.content || '');
    return `${role}:${content.slice(0, 4000)}`; // cap mỗi message tránh hash quá lớn
  });
  const raw = `${model}::${parts.join('||')}`;
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}
```

#### [MODIFY] `src/sessionStore.ts`

Thêm vào `StoredSession`:
- `contextHash?: string` — hash hiện tại của conversation
- `turnCount: number` — số turns đã persist thành công

Thêm vào `SessionStore` class:
- `private contextHashIndex: Map<string, string>` — hash → sessionId
- `resolveByContextHash(hash: string): StoredSession | undefined`
- `updateContextHash(sessionId: string, oldHash: string | undefined, newHash: string): void`
- Load/save `contextHashIndex` kèm file `sessions.json`

Xóa (không còn dùng):
- `SessionKey`, `SessionIdentity` interfaces
- `computeConfidence()`
- `resolveFileBackedSession()`
- `resolveSessionWithIdentity()`

#### [MODIFY] `src/server.ts` — Session Resolution Block (~dòng 1479-1563)

**Thay thế toàn bộ** ~84 dòng logic header cũ bằng:

```typescript
const sessionCfg = conf.settings?.session || {};
const sessionEnabled = sessionCfg.enabled !== false;
let currentSession: StoredSession | null = null;
let sessionMode = 'stateless';
let inboundHash = '';

if (sessionEnabled && messages.length > 0) {
  inboundHash = computeInboundContextHash(messages, model);

  if (inboundHash) {
    currentSession = sessionStore.resolveByContextHash(inboundHash);
    if (currentSession) {
      sessionMode = 'persistent';
    } else {
      // Conversation mới
      currentSession = sessionStore.createSession({ model, source: 'auto' });
      sessionStore.updateContextHash(currentSession.id, undefined, inboundHash);
      sessionMode = 'new';
    }
  }
  // messages.length === 1 → first turn, không có history để hash
  // → tạo session sau khi có response (index bằng outboundHash)
}
```

Sau response (stream path + non-stream path):

```typescript
if (currentSession && responseText) {
  const outboundHash = computeOutboundContextHash(messages, responseText, model);
  await sessionStore.updateContextHash(currentSession.id, inboundHash, outboundHash);
}
```

---

## Feature 2 — Rolling Summary Injection

### Nguyên lý

Thay vì gửi toàn bộ N messages lên Qwen AI (tăng tuyến tính), proxy inject:

```
[SYSTEM: rolling summary] + [last K messages từ client] + [new user message]
```

Prompt size = `|summary| + K messages` = **constant**, không tăng theo số turns.

Summary được cập nhật **async** mỗi `summaryEveryNTurns` turns (default: 5).

So sánh với compact cũ:

| | Compact cũ | Rolling Summary |
|--|------------|----------------|
| Trigger | threshold 40 messages | mỗi N turns |
| Cơ chế | upload file + AI summarize | AI summarize inline |
| Nặng/nhẹ | Nặng (upload OSS) | Nhẹ (1 API call) |
| Liên tục | Không | Có (incremental) |

### Khi nào inject summary

```
Điều kiện:
  session.summary != null
  AND messages.length > rollingHistoryK (default: 10)

→ thay processedMessages bằng:
  [
    { role: 'system', content: '[Conversation context summary]\n' + session.summary },
    ...clientMessages.slice(-rollingHistoryK),
  ]
```

### Config mới (`settings.session`)

```json
{
  "session": {
    "enabled": true,
    "rollingHistoryK": 10,
    "summaryEveryNTurns": 5,
    "summaryMaxTokens": 800
  }
}
```

### Files

#### [NEW] `src/modules/rollingSummary.ts`

```typescript
export async function updateRollingSummary(
  sessionId: string,
  recentMessages: SessionMessage[],
  currentSummary: string,
  adapter: QwenAiAdapter,
): Promise<void>
```

Logic:
1. Serialize `recentMessages` thành text
2. Gọi adapter: `"Summarize this conversation concisely. Previous: {summary}. Recent: {messages}"`
3. Gọi `sessionStore.setSummary(sessionId, newSummary)`

#### [MODIFY] `src/modules/sessionPersistence.ts`

Sau `appendMessages`, kiểm tra:

```typescript
const shouldUpdateSummary =
  session.turnCount > 0 && session.turnCount % summaryEveryNTurns === 0;

if (shouldUpdateSummary) {
  updateRollingSummary(sessionId, recentMessages, session.summary ?? '', adapter)
    .catch(err => console.error('[Session] Rolling summary failed:', err));
}
```

#### [MODIFY] `src/server.ts` — trước khi gọi adapter

```typescript
const rollingHistoryK = Number(sessionCfg.rollingHistoryK) || 10;
if (currentSession?.summary && messages.length > rollingHistoryK) {
  processedMessages = [
    { role: 'system', content: `[Conversation context summary]\n${currentSession.summary}` },
    ...messages.slice(-rollingHistoryK),
  ];
}
```

---

## Feature 3 — Context Overflow Signal

### Nguyên lý

Khi proxy phát hiện context sắp tràn, thay vì silently overflow:
- `mode: 'auto'` — proxy tự xử lý qua rolling summary
- `mode: 'signal'` — trả lỗi chuẩn, client tự compact
- `mode: 'both'` — thử auto trước, nếu vẫn quá lớn → signal

**Claude Code, Cline, Cursor** đều handle `context_length_exceeded` bằng cách tự compact conversation.

### Error format (OpenAI-compatible)

```json
{
  "error": {
    "message": "This conversation has exceeded the context limit. Please compact or summarize your conversation history.",
    "type": "invalid_request_error",
    "code": "context_length_exceeded",
    "param": "messages"
  }
}
```

HTTP status: `400`

### Config (`settings.session`)

```json
{
  "session": {
    "overflowSignal": {
      "enabled": true,
      "mode": "auto",
      "signalThresholdTokens": 90000
    }
  }
}
```

### Files

#### [MODIFY] `src/server.ts` — sau token guard hiện tại (~dòng 1609)

```typescript
const overflowSignalCfg = sessionCfg.overflowSignal || {};
if (overflowSignalCfg.enabled && overflowSignalCfg.mode === 'signal') {
  const threshold = Number(overflowSignalCfg.signalThresholdTokens) || 90000;
  const tokenCount = estimateTokens(processedMessages);
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
    await finalizeRun('failed', { error: 'context_length_exceeded' });
    return;
  }
}
```

---

## Feature 4 — Chat Cleanup

### Hai chế độ

**`after-response`**: Xóa Qwen AI chat ngay sau khi response hoàn tất
- Mỗi turn = tạo chat mới → xử lý → xóa
- Session vẫn lưu metadata (summary, overflow chain)
- Dùng khi muốn privacy: không lưu gì trên server Qwen AI

**`scheduled`**: Background cleanup theo lịch mỗi N giờ
- `proxy-created` (an toàn): chỉ xóa chats có title `"OpenAI_API_Chat"`
- `all` (nguy hiểm): xóa tất cả chats cũ hơn `maxAgeHours`

> Adapter đã có sẵn `deleteChat(chatId)` và `deleteAllChats()` trong `QwenAiAdapter`.

### Config (`settings.session`)

```json
{
  "session": {
    "chatCleanup": {
      "enabled": false,
      "afterResponse": false,
      "scheduled": {
        "enabled": false,
        "mode": "proxy-created",
        "intervalHours": 1,
        "maxAgeHours": 24
      }
    }
  }
}
```

### Files

#### [NEW] `src/modules/chatCleanup.ts`

```typescript
export class ChatCleanupScheduler {
  start(cfg: ChatCleanupConfig, getAdapter: () => QwenAiAdapter): void;
  stop(): void;
  runOnce(adapter: QwenAiAdapter): Promise<{ deleted: number; failed: number }>;
  // fire-and-forget, gọi sau finalizeRun khi afterResponse=true
  scheduleDeleteAfterResponse(chatId: string, adapter: QwenAiAdapter): void;
}
```

#### [NEW] API endpoints

```
POST /api/chat-cleanup/run    — chạy cleanup thủ công
GET  /api/chat-cleanup/status — xem kết quả lần cuối
```

#### [MODIFY] `src/server.ts`

- Khởi động `ChatCleanupScheduler` khi server start
- Trong `finalizeRun`: nếu `afterResponse=true` → gọi `scheduleDeleteAfterResponse(chatId, adapter)`

#### [MODIFY] `src/configStore.ts`

- Thêm `chatCleanup` vào `settings.session` default config
- Thêm vào `updateConfig` deep merge

---

## Bug Fix — Compact Race Condition

Ngăn 2 request cùng trigger compact cho 1 session (ghi đè summary của nhau):

```typescript
// src/modules/sessionPersistence.ts — module-level guard
const compactingNow = new Set<string>();

if (shouldCompact) {
  if (!compactingNow.has(sessionId)) {
    compactingNow.add(sessionId);
    compactSession(sessionId, adapter)
      .catch(err => console.error('[Session] compact failed:', err))
      .finally(() => compactingNow.delete(sessionId));
  } else {
    console.log('[Session] Compact already in progress for', sessionId, '— skipping');
  }
}
```

---

## Tóm Tắt Files

| File | Loại | Nội dung |
|------|------|----------|
| `src/modules/contextHash.ts` | **NEW** | Hash engine: inbound + outbound hash |
| `src/modules/rollingSummary.ts` | **NEW** | Async rolling summary generation |
| `src/modules/chatCleanup.ts` | **NEW** | Scheduler xóa Qwen AI chats |
| `src/modules/upstreamErrorHandler.ts` | **NEW** | Chuẩn hóa lỗi upstream/provider |
| `src/sessionStore.ts` | MODIFY | contextHashIndex, turnCount, bỏ logic header cũ |
| `src/server.ts` | MODIFY | Session resolution mới, summary inject, overflow signal, cleanup |
| `src/modules/sessionPersistence.ts` | MODIFY | Compact guard, trigger rolling summary |
| `src/modules/sessionCompactor.ts` | MODIFY | Không clear hash sau compact; upload fail thì giữ local compact file và skip |
| `src/modules/overflowPolicy.ts` | MODIFY | Raw overflow prompt file, session overflow anchor, upload-fail fallback về messages gốc |
| `src/modules/ossUploader.ts` | MODIFY | Upload OSS + parse/status wait; tăng thời gian chờ parse |
| `src/configStore.ts` | MODIFY | Config schema mới |
| `src/runtime/runStore.ts` | MODIFY | Thêm `deleteRun()` và `clearAll()` |
| `frontend/src/pages/Logs.tsx` | MODIFY | List scroll riêng + lazy render batch 50 |
| `frontend/src/pages/Runs.tsx` | MODIFY | Xóa run, xóa all runs, detail overlay, lazy render |
| `frontend/src/pages/Sessions.tsx` | MODIFY | Xóa sessions, detail overlay, lazy render |
| `frontend/src/styles.css` | MODIFY | `.list-scroll`, sticky table header, lazy status |
| `public/assets/proxy-luna-app.js` | BUILD | Static UI bundle đang được backend serve |
| `public/styles.css` | BUILD | Static CSS đang được backend serve |

## Admin UI / API Đã Bổ Sung

### Logs

- `GET /api/logs?limit=1000`
- `DELETE /api/logs`
- UI render tối đa 50 dòng ban đầu, scroll để render thêm.

### Runs

- `GET /api/runs?limit=2000`
- `GET /api/runs/:id`
- `POST /api/runs/:id/cancel`
- `DELETE /api/runs/:id`
- `DELETE /api/runs`
- UI có overlay detail, xóa từng run, xóa toàn bộ runs, lazy render theo scroll.

### Sessions

- `GET /api/sessions`
- `GET /api/sessions/:id`
- `DELETE /api/sessions/:id`
- `DELETE /api/sessions`
- `POST /api/sessions/:id/clear`
- `POST /api/sessions/:id/compact`
- `POST /api/sessions/:id/rename`
- `POST /api/sessions/:id/reset-provider`
- `POST /api/sessions/reload`
- UI có overlay detail và lazy render theo scroll.

---

## Verification Plan

### Build & Lint
```bash
npx tsc --noEmit
./scripts/lint.sh
```

### Manual Test Flow
1. Chat 1 turn → `GET /api/sessions` thấy 1 session, `turnCount=1`
2. Chat 3-4 turns → cùng 1 session, hash rotate đúng mỗi turn
3. Mở Claude Code window 2, chat khác → 2 sessions riêng biệt, không nhiễu
4. Sau turn 5 → `session.summary` được populate async
5. Chat conversation dài → Qwen AI request thấy `[summary_system] + [last K]`
6. Set `signalThresholdTokens` thấp → nhận HTTP 400 `context_length_exceeded`
7. Enable `afterResponse=true` → Qwen AI chats bị xóa sau mỗi turn
