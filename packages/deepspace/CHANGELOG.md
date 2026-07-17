# deepspace

## 0.6.2

### Patch Changes

- RecordRoom now gates its HTTP debug API (`/api/debug/*`) behind `ALLOW_DEBUG_ROUTES` at the Durable Object's own ingress, matching the app-worker proxy gate. Enforcement lives at the one place every caller funnels through, so it can no longer be bypassed by a caller that forgets to gate. The platform's shared-data rooms hard-disable the debug API entirely. No change for apps that already gate via the proxy.
- Refresh the AI chat model lineup to the current generation. ChatPanel's default picker and the scaffolded starter's `ALLOWED_MODELS` now offer Claude Sonnet 5 (new default), Claude Opus 4.8, Claude Haiku 4.5, and the GPT-5.6 family (Sol / Terra / Luna) alongside GPT-OSS 120B; the retired-generation entries (Sonnet 4.6, Opus 4.7, the GPT-5.4 picker rows) are dropped from the picker, while their ids stay server-allowlisted. The scaffolded chat route now sends `reasoningEffort: 'none'` for OpenAI models — GPT-5.6 on /v1/chat/completions rejects function tools otherwise ("Function tools with reasoning_effort are not supported"). Apps scaffolded before this release that upgrade `deepspace` must add the new model ids to their `ALLOWED_MODELS` in `src/ai/chat-routes.ts` AND add the same `providerOptions: { openai: { reasoningEffort: 'none' } }` to their `streamText` call for OpenAI models (or pass their own `models` prop to `ChatPanel`) — otherwise the picker's new ids are rejected with a 400 by design, and GPT-5.6 turns with tools error.
- Add `BaseRoom.disconnectAllSockets({ code?, reason? })` and a built-in internal
  `POST /internal/disconnect-sockets` endpoint (every room type, `RecordRoom`
  included). Use it after an out-of-band, server-side write (admin import,
  migration script, cron, server action) to close every live WebSocket (default
  close 1012 / `state-refresh`) so clients reconnect and fully resync — no more
  stale editors autosaving over server-side writes. Internal-only: reachable via
  DO stub fetch from the app worker, same trust model as `/api/tools/execute`.
  The client already reconnects and re-subscribes on any close, so `useQuery`
  consumers get fresh data automatically.
- Add `deepspace usage` — credit balance, quota headroom (per-bucket breakdown with renewal/expiry dates), and per-integration spend for the last 30 days, from the platform's billing ledger. `--json` emits the raw summary for scripts and agents. Previously the only balance surface was the web dashboard, which agents driving `deepspace invoke` can't read.

## 0.6.1

### Patch Changes

- Make silent failures visible. `RecordProvider` now accepts an `onWriteError` prop (`(error: WriteError) => void`, where `WriteError` is `{ kind: 'permission' | 'validation', title, detail }`) — previously the friendly-error pipeline (server rejection → `parseServerError` → callback) was unreachable from the public API, so a denied or invalid optimistic write looked like a success with no signal anywhere. Unhandled rejections fall back to a loud `console.error` explaining how to wire real UI (note: this fires in production too — existing apps that never wired a handler will start logging rejected writes to the console; each unique error logs once, repeats are suppressed), and the starter template routes `onWriteError` to its toast system out of the box (permission → warning toast, validation → error toast). On localhost, a signed-out `RecordProvider` without `allowAnonymous` renders a visible diagnostic instead of a blank page (production still renders nothing), and passing `schemas` alongside `roomId` (where it's ignored) warns once; both diagnostics can be forced on or off via `globalThis.DEEPSPACE_DEV = true | false` (LAN/tunnel previews, consumer test suites). `deepspace dev` and `deepspace deploy` now run schema lint up front and print findings (e.g. a `visibilityField` no role enforces) in the terminal, capped at 5 with an overflow count — previously these only appeared in the worker console after a client connected.

## 0.6.0

### Minor Changes

- `deepspace collaborators add <email>` can now invite someone who isn't a DeepSpace user yet: it sends them an email invitation (billed to the app owner) and they become a collaborator when they sign in and accept it. The new `deepspace collaborators cancel <email>` rescinds a pending invite, and `collaborators list` now shows outstanding invites alongside active collaborators.

### Patch Changes

- `deepspace deploy` on a repo without `DEEPSPACE_APP_ID` no longer silently mints a fresh id destined for a route-claim collision when the name belongs to an existing app. Adoption now also recognizes legacy name-as-id apps the caller deploys on-behalf (collaborator or admin): adopting an app you own stays automatic; adopting one you _don't_ own asks for confirmation (or `--adopt` for non-interactive runs); a name owned by an app you can't deploy fails up front with the real reason.

## 0.5.7

### Patch Changes

- 7301e30: Relicense to Apache-2.0 (from the next release onward), add LICENSE files, repository/homepage/bugs metadata, alpha notices, and a README for create-deepspace. Source is now published to the public mirror repo at https://github.com/deepdotspace/deepspace on every release.
