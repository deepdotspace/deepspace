# deepspace

## 0.10.3

### Patch Changes

- Documentation polish: Mintlify-parity UI pass (self-hosted fonts, type scale, sticky launcher, docked assistant, accessible syntax palette, heading-level search), navigation no longer fades over the assistant, MDX imports honor tsconfig path aliases, deploy quota errors name the apps holding slots, scaffolds install with the invoking package manager, and the retired community library publish command is removed.

## 0.10.2

### Patch Changes

- Restore the optional `documentation` feature removed by the 0.10.1 rollback, rebuilt on sound boundaries: compile app-owned Markdown/MDX and OpenAPI into a customizable documentation site at `/docs`, with SPA navigation, search, contextual copy/agent actions, a shared-agent assistant, MCP and Agent Skills discovery, same-release deployment, and explicit custom-domain root mounts.

  Also harden clean package execution, release version integrity, workspace-token verification, browser/Worker schema boundaries, and persisted test-account reconciliation.

## 0.10.1

### Patch Changes

- Withdraw the agent-native documentation release while its CLI packaging and
  workspace-token integration are rebuilt and verified end to end.

## 0.10.0

### Minor Changes

- Add repository-native public documentation: deterministic Markdown/MDX and
  OpenAPI builds, local search, SEO and LLM artifacts, a grounded read-only docs
  assistant profile, agent-friendly `deepspace docs` commands, same-release
  deployment and rollback, explicit docs route surfaces, and docs starters in new
  apps. Publish a stateless, read-only MCP search/read endpoint from the same
  compiled corpus and docs subdomain for external agents. Add a configurable,
  responsive native page-action menu for copying Markdown, viewing source,
  opening the shared docs assistant, and copying the MCP server URL. Consolidate
  app and docs assistants onto one capability-aware, versioned model catalog and
  one SDK agent runner, with provider provenance and build-time compatibility
  validation. Consolidate routing, contextual-action defaults, docs worker setup,
  and the scaffolded agent UI onto single SDK-owned authorities, while splitting
  the runtime, config, CLI, stylesheet, and MCP internals into focused modules.
  Derive docs-owned worker-first routes during deployment so app configuration
  stays minimal and raw Markdown remains directly browser-readable at the edge.
  Expose shared user-schema columns from the browser-safe package root so
  scaffolded schemas do not pull Worker-only modules into client bundles.
  Rank conversational docs questions with cached, proximity-aware lexical
  normalization so grounded commands remain discoverable without another search
  service or agent implementation.

## 0.9.3

### Patch Changes

- Prevent workspace cleanup from deleting unpublished or concurrently advanced commits.

## 0.9.2

### Patch Changes

- Restore traditional manual deployment for GitHub-authoritative apps: ordinary
  deploys now ship the local working tree, including uncommitted changes, without
  Git verification, commits, pushes, or recoverable commit lineage. Commit-first
  sync and workspace lineage remain exclusive to DeepSpace source.

  Track versioned app migrations in `deepspace.migrations.json` and carry that
  manifest in normal deploy bundles and release metadata. Migration completion is
  now independent of Git commit lineage, so the same `deepspace app migrate`
  workflow works for manual GitHub deploys and packaged DeepSpace-source deploys.
  Legacy identity orchestration now lives under the migration command/control
  plane: prepared journals can be canceled, committed cutovers recover forward,
  and ordinary deploy, rollback, ownership, source, and deployment-recording
  paths carry no migration-specific state hooks.

  Bind the bundled messaging schemas' owner fields to the authenticated caller,
  and avoid false-positive owner-field warnings for collections ordinary clients
  cannot create. New apps use Vitest 4 with a standalone unit-test configuration
  so Vite's Cloudflare Worker plugin cannot leak into the Node test runner, and
  include the current app-migration manifest.

## 0.9.1

### Patch Changes

- Keep `deepspace app migrate` as the permanent ordered app-upgrade runner and
  repair obsolete `x-app-name` platform identity wiring before a canonical app
  deployment, without changing retained `APP_NAME` data namespaces. Track
  source-only migration commits against live release lineage so both GitHub and
  DeepSpace apps are guided through the required deploy.

## 0.9.0

### Minor Changes

- Require canonical app ids at normal backend and runtime boundaries while retaining the owner-only `deepspace app migrate` workflow and permanent physical-resource continuity.
- Add first-class single-authority GitHub and DeepSpace source control, including
  manual GitHub verification, provider-aware deploys, and reversible branch/tag
  transfers through `deepspace app source`.
- Add the resumable `deepspace app migrate` workflow for GitHub-owned legacy
  apps. Migrations mint a canonical immutable app id while preserving existing
  Workers, Durable Objects, files, secrets, releases, billing history, routes,
  collaborators, and other physical resources in place.
  Dry-run returns an exact, non-mutating registry re-key inventory, and
  `--cancel` / `--rollback` provide GitHub-first recovery before any canonical
  deployment begins.

### Patch Changes

- Report GitHub-owned cloud Git operations as source-policy refusals instead of app-quota errors.
- Build every SDK entry from one pre-cleaned output directory so concurrent declaration generation cannot remove sibling entry artifacts.
- Install the AI SDK runtime and provider packages used by `deepspace/worker` as
  real dependencies. Apps that do not use the AI helpers no longer fail to bundle
  the Worker because optional provider peers are absent, and an app-owned AI SDK
  v4 install no longer prevents DeepSpace's v5 provider runtime from installing.
  Calls that consume `createDeepSpaceAI` models still use the documented v5 API.
- Keep managed workspace dependencies inside their own Git checkout and roll back a newly created worktree if its private ownership marker cannot be recorded.

## 0.8.2

### Patch Changes

- Publish the SDK after verifying its packed artifacts across the supported Node 22.15, 24, and 26 Linux runtimes.
- Install the AI SDK runtime and provider packages used by `deepspace/worker` as real dependencies, so apps can bundle the Worker without manually installing optional provider peers and an app-owned AI SDK v4 install no longer prevents DeepSpace's v5 provider runtime from installing. Calls that consume `createDeepSpaceAI` models still use the documented v5 API.

## 0.8.1

### Patch Changes

- Align the CLI's esbuild dependency with Vite 8 and pre-approve the required esbuild and workerd install scripts in generated npm 11 apps.
- Make Codex, Claude, and ordinary Git worktrees first-class. DeepSpace now validates Claude paths against Git metadata, isolates ports for every linked checkout, retains externally managed worktrees, creates managed worktrees outside the invoking client checkout without shared dependency links, refuses lineage-losing detached deploys, and scopes ephemeral credential helpers per worktree. Fresh scaffolds finish dependency installation before their initial commit, preserve existing agent metadata and launch configuration, and keep neutral agent instructions canonical.

## 0.8.0

### Minor Changes

- Git-native version control for DeepSpace apps.

  Every app now has a cloud git repo the CLI (and plain git) can talk to over the real Git smart-HTTP protocol, with auth injected automatically:
  - **Sync** — `deepspace clone <app>` materializes the repo; `deepspace push` / `deepspace pull` sync branches; a host-scoped credential helper (`deepspace git-credential`) makes bare `git push space` / `git fetch space` work from any terminal after first use. This removes the GitHub dependency for collaborator code sync.
  - **Versioned deploys** — `deepspace deploy` is commit-first: it auto-pushes the branch, refuses to ship a checkout that is stale or strictly behind the cloud trunk (`--ignore-stale` to override), and refuses a dirty worktree (`dirty_worktree`, exit 2) so every sourced release points at a commit the cloud repo holds. Commit the changes — to a workspace branch when it's WIP — or pass `--no-push` to deploy without version-control sync (the release then records no lineage). `deepspace releases` lists the append-only release ledger and `deepspace rollback` re-ships any prior release whose bundle is still retained.
  - **Workspaces** — the one unit of in-progress work. `deepspace workspace new/attach/sync/list/status/land/drop` gives each parallel agent a durable, named line of work (a hidden ref + task metadata) that survives any sandbox, is resumable from any machine (`attach`), and lands through an ordinary merge. Workspace refs are fast-forward-only, overlap warnings are computed from live peer tips, and land/drop clean up the local worktree by default (`--keep-worktree` opts out). WIP belongs in commits on the workspace branch; it becomes durable when synced and remains reachable through the land merge.
  - **Validate** — `workspace land --validate` runs the project's `validate` script against the merged tree and aborts the land (exit 2) if it fails.
  - **Activity** — `deepspace activity` is a stateless, cursored coordination feed (pushes, workspace lifecycle, releases) so an agent can answer "did trunk move / did a workspace land / did someone deploy" without cloning anything. Callers retain and resubmit cursors: one-shot reads default to cursor `0`, while follow mode defaults to the current tail. `activity --follow --json` emits NDJSON `ready`, `activity`, and retrying `transport` frames.
  - **Bounded storage** — each app has one fixed Git-plus-rollback budget by owner tier: test 0, free 128 MiB, starter 512 MiB, premium 2 GiB, and admin 10 GiB. Accounting covers active Git packs plus distinct retained release bundles. Pushes over the irreducible Git floor are refused; bundle admission evicts the oldest rollback payloads, and a durable purge queue retries R2 cleanup. If a concurrent post-deploy admission can no longer retain the new bundle, the live release is recorded with `bundleRetained: false` instead of re-deploying or discarding older rollback history.
  - **Screenshot boundary** — screenshot capture stays deliberately small and deprioritized. It enforces the configured DeepSpace host boundary on the submitted main-frame URL and every main-frame redirect; subresource policy remains the browser/network boundary's responsibility.

  The CLI surface is agent-first and static: session verbs live under `auth`, app lifecycle under `app`, local development under `dev start|kill`, tests under `test run|screenshot|accounts`, and direct integration calls under `integrations invoke`. There are no compatibility aliases or tombstones for the unshipped tree. `status` reports present-tense facts only. A command that knows one executable follow-up owns exactly one `action: { cwd, argv }`; human output renders the same value as `Next:`. Terminal commands and input-dependent decisions emit no filler action.

  Everything is designed for non-interactive use: commands support `--json`, mutations are idempotency-keyed, and failures carry a stable machine-readable `code` (for example `conflict`, `not_found`, `behind_trunk`, `stale_base`, and `no_releases`). A safe stop that still requires the command's executable local action exits 2 with `actionRequired: true`; failures without one deterministic action exit 1.

### Patch Changes

- Install Framer Motion only when adding the landing-page feature instead of including it in every new app.
- createDeepSpaceAuth: add optional `onUserCreated` observer hook, wired to better-auth's `databaseHooks.user.create.after`. Fires once per new user with the originating endpoint context (request headers/cookies when the signup came over HTTP, null for server-side creations); exceptions are caught and logged so a failing observer can never break signup.
- Windows support fixes. `deepspace create` now runs the scaffolder correctly (it exec's `npx.cmd` via cross-spawn instead of exiting 1 with no output) and reports a spawn failure instead of swallowing it. Scaffolded dependency installs are reliable and observable on Windows: the install runs in the foreground rather than a detached worker that the terminal's job object could kill mid-install, and the log-tail hint is PowerShell-aware (`Get-Content -Wait`) off Windows and `tail -f` elsewhere. CLI error paths (workspace/deploy/pull/push/clone and any escaped error) now stop the active progress spinner before exiting, so an expected error exits cleanly instead of aborting with a libuv assertion. Cross-platform path and process spawning throughout.

## 0.7.0

### Minor Changes

- Remove the legacy single-scope `RecordProvider` API (`roomId`, `schemas`, and
  `wsUrl`). `RecordProvider` now owns only shared auth and scope registration;
  every RecordRoom connection is declared with `RecordScope`. This removes a
  second, drifting WebSocket lifecycle and the silently ignored `schemas` prop.

- Client-side error reporting (opt-in) for `deepspace logs`. Browser JS errors never invoke the Worker, so they never reached Workers Logs. New `installClientErrorReporter()` (client) hooks `window` 'error'/'unhandledrejection' and forwards each to the app's own Worker via `registerClientErrorRoute(app)` (`POST /_deepspace/client-errors`), which logs them so they appear in `deepspace logs` and the dashboard tagged `CLIENT`. Also exports `reportClientError()` for React error boundaries. Off by default (no starter wiring); anonymous ingestion is size-capped, deduped, and throttled, and — because the route runs in the tenant's own Worker — a browser can only ever write to its own app's log stream.

  Also exports the `deepspace logs` wire DTO as a single source of truth (`AppLogEvent`, `AppLogsResponse`, `LogLevel`, `LOG_LEVELS`, `APP_LOG_EVENT_KEYS`) from both `deepspace` and `deepspace/worker`, so the CLI, dashboard, and platform reader share one definition instead of hand-mirrored copies. The client-error module's public surface is limited to the user-facing entry points — `installClientErrorReporter` / `reportClientError` (from `deepspace`) and `registerClientErrorRoute` / `handleClientErrorReport` / `CLIENT_LOG_MARKER` (from `deepspace/worker`), plus the `ClientErrorReport` type; the wire-protocol internals are no longer exported. (Those internals were only ever exported by this same, still-unreleased feature, so no released consumer is affected — this stays a `minor`.)

- New `deepspace logs` command: read a deployed app's production logs (console output, request summaries, exceptions with stacks) from Workers Logs — no Cloudflare dashboard needed. Defaults to the last 15 minutes; `--follow` tails by polling (~3s), `--since/--level/--search/--limit` narrow the window, `--json` emits NDJSON for agents. Logs appear within ~1 minute of a request and are retained for 7 days.
- Rework the scaffolder around a clean starter and a template system.
  - The starter template is rebuilt on a Base UI-backed primitive kit (Dialog/Modal, Select, DropdownMenu, Popover, Tooltip, Tabs, and form controls) with a minimal, unopinionated shell, so scaffolded apps start from a neutral base and design their own look.
  - `npx create-deepspace` now assembles apps from a shared base plus per-template overlays. Choose a template with `--template <name>` (or `-i` for an interactive picker); `starter` remains the default.
  - New `copilot` template: a three-panel shell (collapsible sidebar, a main content panel, and an AI chat dock) with light and dark themes.

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
