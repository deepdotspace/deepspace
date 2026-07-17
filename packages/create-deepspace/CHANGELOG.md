# create-deepspace

## 0.6.2

### Patch Changes

- RecordRoom now gates its HTTP debug API (`/api/debug/*`) behind `ALLOW_DEBUG_ROUTES` at the Durable Object's own ingress, matching the app-worker proxy gate. Enforcement lives at the one place every caller funnels through, so it can no longer be bypassed by a caller that forgets to gate. The platform's shared-data rooms hard-disable the debug API entirely. No change for apps that already gate via the proxy.
- Refresh the AI chat model lineup to the current generation. ChatPanel's default picker and the scaffolded starter's `ALLOWED_MODELS` now offer Claude Sonnet 5 (new default), Claude Opus 4.8, Claude Haiku 4.5, and the GPT-5.6 family (Sol / Terra / Luna) alongside GPT-OSS 120B; the retired-generation entries (Sonnet 4.6, Opus 4.7, the GPT-5.4 picker rows) are dropped from the picker, while their ids stay server-allowlisted. The scaffolded chat route now sends `reasoningEffort: 'none'` for OpenAI models — GPT-5.6 on /v1/chat/completions rejects function tools otherwise ("Function tools with reasoning_effort are not supported"). Apps scaffolded before this release that upgrade `deepspace` must add the new model ids to their `ALLOWED_MODELS` in `src/ai/chat-routes.ts` AND add the same `providerOptions: { openai: { reasoningEffort: 'none' } }` to their `streamText` call for OpenAI models (or pass their own `models` prop to `ChatPanel`) — otherwise the picker's new ids are rejected with a 400 by design, and GPT-5.6 turns with tools error.

## 0.6.1

### Patch Changes

- Make silent failures visible. `RecordProvider` now accepts an `onWriteError` prop (`(error: WriteError) => void`, where `WriteError` is `{ kind: 'permission' | 'validation', title, detail }`) — previously the friendly-error pipeline (server rejection → `parseServerError` → callback) was unreachable from the public API, so a denied or invalid optimistic write looked like a success with no signal anywhere. Unhandled rejections fall back to a loud `console.error` explaining how to wire real UI (note: this fires in production too — existing apps that never wired a handler will start logging rejected writes to the console; each unique error logs once, repeats are suppressed), and the starter template routes `onWriteError` to its toast system out of the box (permission → warning toast, validation → error toast). On localhost, a signed-out `RecordProvider` without `allowAnonymous` renders a visible diagnostic instead of a blank page (production still renders nothing), and passing `schemas` alongside `roomId` (where it's ignored) warns once; both diagnostics can be forced on or off via `globalThis.DEEPSPACE_DEV = true | false` (LAN/tunnel previews, consumer test suites). `deepspace dev` and `deepspace deploy` now run schema lint up front and print findings (e.g. a `visibilityField` no role enforces) in the terminal, capped at 5 with an overflow count — previously these only appeared in the worker console after a client connected.

## 0.6.0

## 0.5.7
