# deepspace

## 0.24.0

### Minor Changes

- Admin direct gifts: admins can gift bonus credits straight to an existing user by email from the dashboard's admin Credits page (renamed from "Credit Requests"). Each gift is recorded as an already-approved `kind='gift'` row in `credit_requests` — it shows tagged in the admin list and as "Gift from the DeepSpace team" in the recipient's Billing history, and the grant shares the same expiring-bonus semantics as approvals and promo redemptions. The credits dialogs were also hardened: API errors always surface curated copy (raw server/transport messages never render), and Esc/backdrop can't dismiss a dialog while its request is in flight.
- Managed knowledge base: an app can declare one `[[ai_search]]` binding with `instance_name = "auto"` and get an isolated Cloudflare AI Search instance, provisioned on deploy and torn down on undeploy like any other `"auto"` resource. The new `knowledge(env)` helper on `deepspace/worker` and `deepspace/server` exposes `add` / `list` / `remove` / `search`, plus `scoped({ folder })` for a handle whose folder a caller cannot widen — safe to hand to an agent as a tool. Folders are recursive prefix scopes; oversized text files are split at UTF-8-safe boundaries and oversized binaries are refused rather than corrupted.

  The resolved binding is control-plane metadata only: it is stripped before the Workers-for-Platforms upload, so no Cloudflare token, instance id, or `ai_search` binding ever reaches the customer Worker, and `ai_search_namespaces` is refused outright. Every operation is authenticated per app and charged in the API worker, so calling the route directly is billed exactly like the helper. Search is charged up front, ingestion reserves and settles against the real indexed-token count, and storage is sampled daily — all at the existing 10% platform binding markup (third-party integrations are unchanged at 30%) and surfaced in the dashboard's Binding Usage card. Available on every plan.

- Add `--viewport WIDTHxHEIGHT` to `deepspace test screenshot`. The helper normalizes the dimensions for Playwright's installed Chromium browser, enabling reliable mobile captures without selecting a device profile backed by an uninstalled browser.
- Promo codes: admins (and Beacon, via app identity + owner JWT) can bulk-mint single-use codes that grant expiring bonus credits — idempotent per (campaign, email) when a campaign is given — and users redeem them from a new "Redeem Code" card on the dashboard Billing page. Includes an admin mint dialog on the Credits page and a rate-limited, race-safe redeem endpoint. Each code also carries a clickable claim link (dashboard `/claim/<token>`): signed-out recipients see the offer, sign in, and the credits auto-apply — the grant attaches to the claim, not to signup, so pre-existing accounts and any click/signup order work.
- Remove the `workspace:default` shared scope — the one platform-wide Durable Object that held "cross-app shared business data" for every app. The `WORKSPACE_SCHEMAS` export (`deepspace/schema`), the `workspace` entry in `GLOBAL_DO_TYPES`, and the platform worker's acceptance of `workspace:default` as a global scope id are gone; the platform now answers `400 Invalid global scopeId` for it. Cross-app data is an app's own `dir:{appId}` room or a `conv:{convId}` room, never a single DO shared by all apps. Team-scoped RBAC (`teamField` / a `team_members` collection) is unchanged and remains available to any app's own rooms.

### Patch Changes

- Stop gating source selection and transfers on unrelated local Git state. Initial GitHub claims and direct GitHub repository changes now require only remote reachability, matching deploys that intentionally ship dirty and unpushed bytes; provider transfers still verify the authoritative refs and release lineage before flipping authority.
- Stop credit-request approvals from resurrecting a user's expired bonus credits: when the existing bonus allocation has already expired, approving a grant now resets the balance to just the newly granted credits instead of adding to the stale amount and refreshing its expiry.
- `deepspace app update` now reports the secure-room-boundaries blocker wherever the legacy room proxy lives, not only at `src/server/realtime-routes.ts`. An app that had moved its WebSocket proxy and still forwarded identity in the URL passed `app update` clean, then reached the room as anonymous on every connection — RBAC filtered every row and signed-in users saw an empty app. The blocker scan is keyed on content (a file that forwards a request and sets `userId`/`role`… on its URL) instead of on the file path; the auto-rewrite is unchanged. Rooms also log a warning when a connection carries `?userId=` with no `x-user-id` header, so the pre-0.19 proxy shape names itself in `wrangler tail`.
- Return a stable duplicate result when an update violates a collection's `uniqueOn` constraint.
- Fixes from the v0.23.2 production AX pass. Server: the `user.list` assistant tool now returns exactly what the socket roster gives the caller (admins full rows through the read policy; everyone else the public identity projection, honouring `read: false` and `roster: 'read-policy'`; app actions keep full rows) — it used to hand every member every user's email; the public identity projection now carries `lastSeenAt`, so `usePresence()` works for non-admins (it was always offline for everyone but the owner); `timestampTrigger` writes canonical epoch seconds on a `storage: 'number'` date/datetime column instead of an ISO string that stored the year or milliseconds inconsistent with explicit writes; an empty string written to a text column is stored as `''` (it was folded into NULL, so the field read back absent and a `default: ''` never materialized); `where` on `records.query`/`deleteWhere` refuses arrays and non-objects at the one shared chokepoint; `deleteWhere` authorizes with delete permission independently of read permission; the client's `writableFields` refusal names the role and field again. CLI: `deploy` states on both surfaces that a rename does not carry the display name (`src/constants.ts` and `wrangler.toml [vars] APP_NAME`) and the `--rename` success envelope carries `renamedFrom`/`staleDisplayName`; `collaborators add` discloses that a collaborator can read and change every secret (`grants` in `--json`); the false "attributed to the app's owner" warning on collaborator deploys is gone (the ledger records the collaborator); `app source github` removes a stale `space` git remote (`spaceRemote` in `--json`), refuses stale import writes after an authority flip, rechecks GitHub after import, and preserves a successful flip when local remote reconciliation fails; `push`/`pull`/`clone` share one GitHub-source refusal with `repository` and `appId` as fields (`apiFetch` now keeps every server-provided field on `ApiError.details`); `push`'s uninitialized-scaffold refusal is `actionRequired` (exit 2) like `deploy`'s; `releases`/`status`/`activity` name a GitHub-source release's source instead of "(no source recorded)"; a GitHub-source deploy reports its branch and whether the tree was dirty (both surfaces); `app update` is now a successful read-only guide tied to the running CLI version: it reads only explicit app manifests and never rewrites source, stamps migrations, runs an installer, scans unrelated packages, imposes DeepSpace Git transport checks, or treats outstanding work as a command failure; local/file/workspace/VCS SDK specs report `dependency_unverified` instead of a false aligned state, and malformed migration ledgers refuse with `invalid_migration_manifest`; `test run --json` routes the Playwright dependency preflight to stderr through the same chokepoint as the suite and says up front when it will run `apt-get`; the `unknown_suite` refusal mentions `--grep` and single-spec paths; `test accounts create` no longer prints the password (it is saved locally; `list --reveal` shows it); `ActionTools` gains `deleteWhere` (template + upgrade guidance). Deploy locking no longer reclaims stale paths automatically, and release callbacks delete only the lock they own. Scaffolder: `create-deepspace@X` pins `deepspace` to exactly `X` (a caret let a pinned scaffolder install the newest SDK) and prints the SDK version it installed.

  Second round (wave 2 of the pass — recovery, upgrade, observability). CLI: a present-but-malformed `DEEPSPACE_APP_ID` is refused as `invalid_app_id` at the one id resolver (it was reported as "no app id" and the offered `app init` orphaned the app; `app init` now refuses to overwrite it without `--new-id`); the "no app dir" vs "app dir without an id" states get one code each (`not_in_app_repo` / `app_not_initialized`) across `deploy`, `secrets`, `test`, `dev`; `secrets` and `auth login` refusals go through the shared envelope (`not_authenticated` with its action, `network_error` naming the service and env var, `file_not_found`, `invalid_credentials`); `not_authenticated` names the selected plane vs the plane holding a session (`DEEPSPACE_ENV`/`DEEPSPACE_AUTH_URL`) and the headless login form; `push`/`pull`/`deploy` refuse `merge_in_progress` mid-merge instead of pushing the pre-merge commit; `deploy` takes a local `.deepspace/deploy.lock` (`deploy_in_progress` names the other run) so two deploys in one directory no longer race on `dist/`, `release_in_progress` explains itself and carries a retry action, `forbidden` names the signed-in account and the app, and after the edge confirms a release `deploy` wakes the worker once; `undeploy`'s confirmation says what is destroyed (the app's Durable Objects: records, messages, canvas state, cron history — the old sentence said "data stays") and what stays (secrets, registration), names the app, and a second undeploy reports `alreadyUndeployed`; `logs` on a never-deployed app refuses `app_not_deployed`; `app init --json` reports the plane as `env` (the wrangler slot is `wranglerEnv`); `test accounts list --json` prints passwords only with `--reveal`; `status --help` names `env`/`services`; `integrations invoke` refuses a paid call outside a terminal or under `--json` without `--yes` (`cost_confirmation_required`; the interactive prompt defaults to No) and `integrations info` synthesizes an example body from the schema's required keys; `app update` reports guidance for the build-injected app id and action-route bearer guard without mutating the checkout; `app init`'s `app_not_registered` refusal ships the `--new-id` action; `workspace land` pins its follow-up to the surviving primary checkout instead of the managed worktree it just removed. Server: a cron schedule arms on the worker's first request (`armCronRoom`, wired in the template) instead of waiting for its Durable Object to be fetched by a visitor, and rejected or non-2xx wake attempts remain retryable; cron and job runs log one structured line each; the template's `app.onError` logs a thrown error's message (Hono's default rendered only the stack frames, so `deepspace logs` never carried it). Platform (ships with the next worker deploy): a created-never-written secrets config answers `{}` instead of "Project DEK not found"; non-request log invocations (alarms) are labelled with their entrypoint; the integrations catalog discloses the customer price after markup and currency conversion (`null` for metered `per_actual_cost` endpoints, `variesWithInput` where multipliers apply), and `integrations list`/`info`/the consent prompt label an input-dependent figure as a base rate that can move lower or higher instead of falsely calling it a floor. Template: the action route logs `[action] <name> caller=<userId>` (the platform request log carries no user), with upgrade guidance for existing apps.

## 0.23.2

### Patch Changes

- Fixes from the v0.23.1 production AX pass: `create-deepspace` exits nonzero when its registration step fails (and says "scaffolded, no app id yet" instead of "is ready"), renders the CLI's refusal sentence instead of a raw JSON envelope, offers `auth login` only when the failure was a missing login, names the account and plane it registered on, and takes `--no-register` (plus a hint that `--yes` is unnecessary); `records.query` refuses a `where` key that names no field (an ignored key returned the whole readable collection as if filtered — the same class `deleteWhere` refuses); `deepspace pull` checks the cloud repo before writing the `space` git remote, so a GitHub-source refusal no longer leaves the push-capable remote behind; `deploy --json` reports a stray server refusal under its real code instead of `deploy_failed` wrapping the JSON as text; `app undeploy` confirms at an interactive terminal (`--yes` skips; scripts and `--json` are never prompted); `test run --json` streams the suite on stderr so stdout is the single JSON line; `status` always states the environment (`env`, `services` in `--json`); the rename prompt says the display `APP_NAME` does not travel, and lives in one place for both the pre-build and commit-time paths.

## 0.23.1

### Patch Changes

- Chat writes can no longer resurrect a deleted chat, the delete cascade is bounded, and cookie-only server-action calls get a 401 instead of a 500. `updateChat` and `appendMessage` now re-check the chat through `getChat` and return `false` instead of writing when it is gone (`records.update`/`records.create` are upserts, so an unguarded post-stream write recreated a deleted chat as a title-less ghost). New `records.deleteWhere` tool on the room tools API — `{ collection, where, limit }` → `{ deleted }`, bounded per call, same delete permission check as `records.delete` and refusing the whole page if any match is denied — lets `deleteChatCascade` spend one subrequest per page instead of one per message. The scaffolded `POST /api/actions/:name` reads the bearer token defensively: an authenticated caller with no `Authorization` header is now refused 401 rather than throwing, and the file carries the trust-model note that action tools execute as the caller with RBAC off.
- CLI honesty pass: `deepspace test run`'s default suite now names every spec file it skipped (prose line + `skippedSpecs` in `--json`); `push` refuses a GitHub-sourced app in its preflight, naming the repository, instead of reconstructing a repository-less sentence from git's discarded 422; `push`'s `no_commits` refusal and `app init --new-id` both name their next step; and a scaffold whose identity registered no longer tells you to `auth login`.
- `deploy` settles two refusals before it builds and uploads: a collaborator whose app has no live `APP_OWNER_JWT` is refused with the platform's own sentence and a new `owner_jwt_missing` code (the deploy worker's commit-time 409 now carries that code too), and a changed wrangler `name` is confirmed or refused (`rename_required`) from the registered host instead of after the upload.
- Verification-pass fixes: `records.deleteWhere` refuses a `where` whose keys name no field (an unknown key used to be silently dropped, deleting an unfiltered page), refuses schemaless collections and non-numeric limits, and pages after the RBAC read filter; a users schema with an explicit `read: false` keeps an empty roster for that role, and a role change now refreshes every connected roster; the scaffold's chat route stops (rather than continuing) when a mid-stream delete makes `appendMessage` return `false`, and `PATCH /api/ai/chats/:id` answers 404 for a write that never landed; the build plugin's `.dev.vars` sweep clears every worker dir before reporting an unsafe one; a missing `wrangler.toml` is `not_in_app_repo` with a remedy instead of `invalid_config`, and `detectAppName` shares the one reader; `push`'s `no_commits` names the `__APP_ID__` case only when the placeholder is present (with the `app init` action); `app init` ships a `git commit … wrangler.toml` action when it did not commit; secrets refusals keep the server's `code` in `--json`; `app list` shows a renamed app's reserved old name.
- AX-pass fixes: `secrets` reads on an unregistered app id refuse `app_not_registered` instead of answering an empty list; the scaffold registers its AI chat routes only when the copilot schemas are present (they could only 500 without them) and names the valid model ids (`unknown_model`) on a bad `modelId`; `create-deepspace` says which plane it registered the app on and which id; deploy/push/pull/update/workspace share one `not_in_app_repo` sentence; `lintSchemas` warns when a role uses the `'team'` level with no `team_members` collection; an implausible command guess is no longer handed back as an executable `action` and `logout` counts as destructive; `transfer accept` names collaborators inherited from the previous owner; `secrets set/upload/delete --json` carry `appliesAtDeploy: true`; `rollback --help` states secrets are kept; `app update` leaves a `file:`/`link:` deepspace spec alone.
- Review follow-ups: `executeQuery`'s `limit` now counts the records the caller receives — when a per-row read filter applies it scans in bounded batches (a 5,000-row scan budget per call — worst case one batch of `max(limit, 200)` rows past it, and a `limit` above the budget is honored as asked — reported to callers that ask, so `limit` stays a bound on work) instead of letting a SQL `LIMIT` end the result early, and `read: 'own'` / `read: true` push into SQL like `'team'` already did (only when the declared field resolves to a real column — a misdeclared one falls back to the per-row check instead of throwing) (so `records.deleteWhere` pages boundedly under RBAC, and a partially-failed page is refused rather than read as "no more matches"); a new `roster: 'read-policy'` users-schema option scopes the `user.list` roster to the caller's read policy for tenant/team-partitioned apps; ranked command guesses are never handed back as executable actions (only an exact quoted path is); `classifyPushTransportFailure` keeps a last-resort 422 → `source_managed_by_github` fallback; `transfer accept` reports `inheritedCollaborators` on replays too; `app init` offers its `git commit` action only when wrangler.toml is actually uncommitted; one anonymous-identity helper (`isAnonymousUserId`).
- The users roster (`useUsers()`) now updates live: a room pushes `user.list` to every other connected socket when a user registers for the first time or changes name, avatar, or role — the client only asked once per connection, so a peer who joined after a tab connected rendered as "Unknown" there until reload.
- `app list` now surfaces incoming ownership offers and an undeployed app's reserved name, `transfer accept` reports a replayed acceptance as a replay instead of a fresh handshake, and `transfer status`/`offer` name the offerer and say that acceptance ends the offerer's access
- Fix `useUsers()` returning an empty roster (chat authors rendered as "Unknown") in rooms without an app `users` schema: the users list now returns every registered user's public identity to non-admin callers instead of filtering by the schema's row policy, which still guards full-row reads.
- One wrangler.toml reader behind the CLI and `deepspace/build` — one error shape (`WranglerConfigError`; a missing file is `not_in_app_repo`, a broken one `invalid_config`). **New refusal, `duplicate_app_id`:** a wrangler.toml that sets the same `DEEPSPACE_APP_ID` under more than one section (`[vars]` and `[env.<name>.vars]`) is refused by every CLI command and by `vite build` — each environment is its own app; run `deepspace app init --env <name>` to mint one for it. `test accounts recover` restores the display name the platform now returns.

## 0.23.0

### Minor Changes

- Fix the six top findings from the five-app AX audit: enforce chat ownership in `getChat` (a signed-in user could rename, delete, or write another user's AI chat), make failed writes observable instead of silently succeeding (system-managed column updates, queries against a collection the room does not carry, and writes attempted before the room is ready — now a `not_ready` `WriteError`), key the Playwright storage-state cache by origin and validate the session before reuse (raising `TestSignInError` rather than returning a signed-out context), resolve the browser bundle's app id from the wrangler config being built so `deploy --env` cannot ship a bundle wired to another environment, add `deepspace test accounts recover` so pool accounts created on another machine are usable, and ship a scaffold whose `collab.spec.ts` passes on a fresh app.

  **Upgrading — apps scaffolded on 0.21.0–0.22.1.** Those scaffolds baked a literal app id into `src/constants.ts` and carry no `deepspace/build` wiring. They keep working untouched: plain `deploy` passes (the new bundle guard refuses only a FOREIGN id), and already-deployed apps are unaffected. What changes: `deploy --env <name>` is now **refused** (`app_id_env_mismatch`) instead of silently shipping that environment's worker against production's rooms — the refusal lists the three file edits that adopt the build-time id (`vite.config.ts` → `deepspaceBuild()`, `vitest.config.ts` → `appIdDefine()` if present, `src/constants.ts` → `__DEEPSPACE_APP_ID__`); there is deliberately no automatic migration for these app-owned files. Relatedly, `app init` no longer stamps ids into source files at all — wrangler.toml is the id's only home, and the client resolves it at build time. (The unknown-collection suffix below applies to the `resolveCollection` paths — subscription queries, record tools, and Yjs collection checks.)

  **Upgrading.** Two signatures changed: `getStatePathForEmail` and `readCachedState` from `deepspace/testing` now take `(email, baseURL)`, since the cache is keyed by origin as well as account. `WriteError.kind` gains `'not_ready'`, which only breaks an exhaustive `switch` over the union.

  **Two changes reach code the SDK cannot upgrade for you**, because worker routes are vendored into your repo at scaffold time. First, the unknown-collection error text gained a suffix naming the room and the collections it serves; it now reads `Schema not registered for collection: <name> — Room '<scope>' serves only: …`. The shipped template and the data-boundary migration guide both match it with `startsWith`, so supported code is unaffected, but a vendored route comparing with `===` stops matching and falls through to its error branch — in `getDocumentForAccess` that is a 403 on every Yjs document room. Change any such comparison to `startsWith`. Second, `records.query` against a collection the room does not carry now returns `{ success: false }` instead of `{ success: true, records: [] }`; since `executeTool` throws on `!success`, a cron handler or server action querying an optional collection now fails its job rather than seeing an empty list. Guard those call sites, or register the collection in the room.

  **Scope of the system-column refusal.** It covers the `users` columns you can mean to set — `email`, `name`, `imageUrl` and `role`. The server-maintained timestamps `createdAt` and `lastSeenAt` are still preserved silently: the server rewrites `lastSeenAt` on every connect and every presence heartbeat without broadcasting, so a whole-record echo carries a stale value the caller never chose and has no way to refresh. Sending any system column at its current stored value still succeeds, and `null`, `''` and omitting the field are treated as the one stored state they are.

## 0.22.1

### Patch Changes

- Unregistered or foreign app ids now get real recovery paths instead of dead ends: `app init` verifies registration (and ownership) before answering "already initialized" and names `app init --new-id` when that is the remedy; `deploy` and `push` refuse up front with the same guidance instead of raw git errors; secrets errors carry the server's machine code; the deploy refusal ships an executable action; the scaffolder's failure guidance no longer assumes the not-signed-in case.

## 0.22.0

### Minor Changes

- App ids are now server-minted and owned from birth: `deepspace app init` (logged in) asks the platform for an id that is registered to your account the moment it exists, the scaffolder runs `app init` as its final step, and `deepspace deploy` refuses an app with no id instead of minting one locally. The platform no longer registers unknown ids on first deploy (previews included), push, or secrets write (`app_not_registered`) — so nobody can claim an app id out of your wrangler.toml before you do. The initial scaffold commit moved with the identity: `app init` commits a still-unborn scaffold repo, so a logged-out scaffold stays uncommitted until login + `app init` heal it.

### Patch Changes

- The tracked-secret-files deploy warning no longer promises the deploy will continue: without the skipped push the release carries no source lineage, and the server refuses it as stale when the live release has one (`--ignore-stale` overrides). The server's `stale_base` message now lists the secret-file skip among its causes.

## 0.21.0

### Minor Changes

- Cron mutation receipts: `useCronMonitor`'s trigger/pause/resume now resolve a typed `CronMutationResult` over a new `cron.ack` frame (a trigger resolves once the run completes; its execution record arrives via `history`), and the hook surfaces previously dropped server ERROR frames as `lastError`. Pause/resume of an unknown task now rejects with `unknown_task` (and a missing `taskName` with `failed`) instead of acking success.
- The files round trip works and failures are visible. `upload`/`uploadBase64` accept `{ key }` to place an object at an exact location within the scope (slashes allowed, upsert semantics — the server contract the CLI already used), so `upload` then `list(prefix)` finds what you stored; `name` stays display metadata. `list()` now throws a humanized error on auth/server failures instead of silently returning an empty directory, accepts `{ limit, cursor }`, and the new `listPage()` returns `{ files, cursor, truncated }` for real pagination past the server cap. Entries and upload results carry `relativeKey` (the key within your scope). Also fixes a cross-page listing bug where a cursor continuation could re-list keys earlier pages already returned. The file-manager feature renders list failures with a retry instead of an empty grid.
- Integration failures arrive typed and human at the same time. `IntegrationResponse.error` is now the human-readable message (it was the machine slug — which is why raw `insufficient_credits` reached product copy); the slug moves to `code`, with `status` and structured `details` (for example `availableCredits`/`requiredCredits` on a 402) preserved instead of discarded. `useCheckout`/`useSubscription` surface the same typed `code` (so `owner_connect_not_ready` is branchable, not string-matched), and `integrations invoke` prints the human line while carrying the real slug in its refusal. Chat completions that spend the entire token budget on reasoning before any visible output now fail typed as `output_budget_exhausted` with the budget in the message, instead of returning an empty string. On `output_budget_exhausted` the worst-case pre-charge stands (no reconciliation), the same as any other handler failure.
- Testing stops lying to you. Cached Playwright sign-in state is validated against the target app before reuse (session probe plus identity match, keyed by auth scope + app origin + email) instead of trusted for seven days on file age alone — a fresh-but-dead state file can no longer poison every protected test. `test accounts list` now shows the fixture selector name and a `usableByFixture` flag (with `--usable` to filter and passwords masked behind `--reveal` in human output; `--json` still carries them for automation), and accounts created without `--name` default it from the email so they are always selectable. `test run` accepts `--grep`, `--project`, and `--headed`. `dev start` no longer lets Vite clear the terminal over the CLI's own preflight output. The new `deepspace/testing/mcp` subpath ships a dependency-free MCP wire client (initialize/listTools/callTool/notify) used by the SDK's own new wire tests. Breaking for test-harness code that reached into the cache internals: `readCachedState` is removed from `deepspace/testing` (validation replaced age-based reuse), `getStatePathForEmail` now requires a `baseURL` second argument because cache identity is keyed by auth scope + app origin + email, and `EnsureStorageStateOptions.maxAgeMs` is gone.

### Patch Changes

- ChatPanel's first chat can no longer vanish. When mounted with `chatId={null}`, the panel now keeps the chat it creates (prop changes still win, including back to null for "new chat"), so messages render and persist without requiring the parent to wire `onChatCreated` — previously the screen stayed permanently empty and every further send leaked another chat record. `onChatCreated` is a plain notification again. The AI chat page also stops offering "Retry" (which created a new chat) after a failed delete, and surfaces rename failures instead of logging them.
- Brandable AuthOverlay (title/description/logo props, `--ds-auth-backdrop` var), an in-page signed-out fallback for the scaffold's protected routes, Modal long-string wrapping, integration-test catalog error/retry states, and a token-styled cron log page.
- Fix agent-reported workspace continuations, file metadata and generated file-manager behavior, collaborator recovery guidance, documentation theme strict mode, and source-mode guidance.
- Deploys are bounded, faster, and tell you where the time went. Every deploy HTTP call now carries an explicit per-attempt timeout (60s; the commit POST gets 240s and retries once instead of three times, since each re-POST records a release) — a hung deploy service surfaces as a fast retryable failure instead of a silent multi-minute stall. Asset uploads run 16-wide instead of 4-wide, which matters exactly on many-small-file first deploys where per-request round trips, not bandwidth, dominate. The CLI now prints phase durations — `Built (Ns)`, `Uploaded N file(s) in Ns`, `Platform commit: Ns`, `Deployed! (edge confirmed in Ns)` — so a slow deploy names its slow phase instead of demanding forensics.
- Native documentation gains `theme.density: "compact"` — one config key that tightens type scale, measure, padding, header, and sidebar through new geometry tokens (`--documentation-font-size`, `--documentation-line-height`, `--documentation-content-width`, `--documentation-reader-pad`), so matching a compact host no longer takes hundreds of lines of custom CSS. Unknown `theme` keys now warn instead of silently vanishing, and the config input type now carries exactly the settable keys — `preset` (never implemented) is gone, and resolved-only keys (`backgroundDark`, `backgroundDecoration`, the font fields, `codeBlockMode`, `eyebrowStyle`, `logoHref`) moved to the new `ResolvedDocumentationTheme` type (Mintlify normalization is unaffected). Documentation output now records the `deepspace` version that built it — in the manifest and as a small footer line — so a docs site can't silently describe an older SDK. The machine surfaces get honest edges: `documentation_search` flags weak matches with an explicit notice instead of returning confidently-scored misses, `documentation_read` accepts slash-less routes and returns just the requested `#fragment` section (whole page plus a notice when the fragment is unknown), and a missing `.md` page answers with a one-line plain-text 404 instead of the styled HTML page.
- The integration catalog now tells you what each endpoint does before you call it: `deepspace integrations list` prints a one-line description per endpoint (with an OAuth tag where the platform manages the OAuth connection), and `integrations info` adds the description, a Requires-OAuth explanation of the retry flow, and a curated output schema for endpoints whose success shape the platform defines. `--json` carries the same fields.

## 0.20.0

### Minor Changes

- Harden and simplify app-file storage with race-safe quota summaries, fixed-layout recoverable multipart reservations, strict public/private scope isolation, bounded request bodies, and safe downloadable HTML/SVG/JavaScript attachments. Quota-enabled custom handlers must now provide a coordination key.

## 0.19.5

### Patch Changes

- The CLI's documentation pointer follows the docs cutover: `deepspace app update` guidance and the npm README now link https://docs.deep.space (documentation.deep.space is retired).

## 0.19.4

### Patch Changes

- Documentation feature quality pass. Navigation is a hard cut: the view-transition machinery is deleted outright, a route swap commits in one synchronous frame with scroll applied in the same commit (from a settled scroll exactly [oldY, 0] is observable — cross-page hash arrivals included), and a failed popstate restore reloads instead of leaving stale content. The Ask AI launcher is a single glass input row (the "Ask AI" chip is gone), stays present through the end of the article, and no longer paints a gradient band over content; the composer auto-grows to a 160px cap with no visible scrollbar below it; send buttons share one circular spec with readable ink on the accent in both themes; assistant errors render as callouts. Dark mode gets a readable accent via the new theme.accentDark option (also mapped from Mintlify's colors.light) with an automatic lightened fallback. The outline highlight follows every click, including short last sections (reading-line scroll spy). Sidebar active state, callouts, and the navigation progress bar are flat — no gradients, no glow. Code blocks: the language label becomes a hover chip (reclaiming 38px per block), filename fences render a title bar on both content paths, and fence options like {1,3-4} or wrap no longer masquerade as titles. Anchors land at a single scroll-padding clearance. Chrome spawns no native drag ghosts, never selects its labels, and its inputs never invite autofill; og:image now pairs with twitter:image; the unused navigation.global config field is removed.

## 0.19.3

### Patch Changes

- Publish the manual app-update migration guides in the public release mirror and link each updater result to its version-matched guide.

## 0.19.2

### Patch Changes

- Harden post-release upgrade and scaffold behavior: pin only real package
  dependencies, expose PresenceRoom offline state, restrict fresh user rows to
  their owners, wire feature roles and cron tasks correctly, and remove generated
  build-preview secrets from deploy output while guiding existing Vite configs.

## 0.19.1

### Patch Changes

- Enforce `users` read permissions in user-list responses and `writableFields`
  on record creation. Reauthorize job snapshots and live events so revoked users
  cannot retain queue access. Generated canvas and cron routes forward current
  app roles without removing anonymous read-only access. Generic authenticated
  Yjs rooms remain available when no `documents` schema exists, while a missing
  document in a documents-backed app fails closed. Existing apps can apply the
  documented app-owned route edits manually; `deepspace app update` does not
  rewrite them.
- Let CLI commands exit naturally after releasing their handles, make Windows
  `dev kill` handle free ports correctly, apply scaffold migrations in CRLF
  checkouts, and report partial Git worktree removals accurately.
- Fix the clear post-release AX issues: avoid anonymous presence token failures,
  remove direct-build secret artifacts and secure existing credential files, make the
  Documents feature honor mutation readiness and confirmed ACL writes, and pin
  the AI SDK family away from its moderate/high advisory path. Keep anonymous
  RecordRooms from exposing the user directory, and limit non-admin user lists to
  the public identity fields required for collaboration. Keep an app's direct AI
  SDK dependency on the compatible version when `app update` advances DeepSpace.

## 0.19.0

### Minor Changes

- Block paid app checkout until the owner can accept charges and payouts; require
  current app roles for direct job mutations and enabled production debug routes;
  disconnect role-changed sockets; remove email/avatar data from ephemeral
  presence; refresh ordered/limited live-query snapshots; and clean Yjs awareness
  per subscribed document. Also retain the earlier claimable-ownership, room
  identity, log-sanitization, generated-artifact, and first-run agent-DX fixes.

  Existing beta apps must run `npx deepspace@latest app update` with this release
  so the migration is run by the target CLI. It moves verified room identity from
  URL parameters to internal headers and installs the stock job-role/debug-route
  checks using the SDK's shared app-role lookup. Customized seams receive a
  precise manual blocker; no legacy runtime compatibility branch is retained.

  Generated apps also drop unused model-provider packages and the legacy
  Documents editor migration. Record writes expose existing room readiness and
  fail with a stable `not_ready` error before connection; Yjs rooms expose current
  transport connectivity. Testing sign-in keeps safe server error codes,
  workspace land returns the deterministic pull action when needed, and generated
  Documents code is typechecked from the packed release artifact.

## 0.18.0

### Minor Changes

- **Deploy no longer reads `.dev.vars`. The secret store is the only source.**

  Deploy used to compare hand-edited `.dev.vars` keys against the store and
  refuse (`secrets_not_uploaded`) or warn when they differed — a guard that
  inferred intent from a local file. It also broke its own escape hatch: the
  refusal pointed at `secrets upload .dev.vars` while that same deploy had
  already written the SDK-managed block into that file, whose keys the upload
  then rejected, with no code and no action to recover from. An agent that hit
  it had no way forward.

  `.dev.vars` keeps its real job — deploy WRITES it so `deepspace dev` sees the
  same values — and is never read back to decide anything.

  **Removed:** the `--allow-missing-secrets` flag and the `secrets_not_uploaded`
  refusal code, which only existed to escape that guard.

  Deploy now distinguishes a missing config from an explicitly created empty
  config. A missing config regenerates the local cache without app secrets and
  refuses before build, Git push, or upload, with an executable
  `secrets configs create` action. An existing empty config is explicit
  delete-all intent. The deploy server independently preserves live bindings
  when an older client omits secret authority, making the rollout safe in both
  directions.

  Authoritative deletion is part of release finalization, not a best-effort log.
  The server retries Cloudflare reconciliation three times and retains the
  per-app release fence on failure. Replaying the exact deploy retries deletion
  without issuing a second Worker activation; a release is recorded only after
  stale bindings, including `ALLOW_DEBUG_ROUTES`, are gone.

  If the original CLI process exits after that partial result, a fresh deploy key
  can resume only when the complete Worker, secret, attribution, and source
  lineage hash matches the live operation. The server first proves that exact
  operation is live at Cloudflare; different input stays fenced. Malformed
  successful Cloudflare secret-list envelopes also fail closed.

  The per-app release transaction is now reserved before route registration,
  binding auto-provisioning, or rate-limit allocation. Losing concurrent deploys
  therefore return without renaming the production app or creating provider
  resources. An incomplete reservation cannot activate; an exact retry may
  atomically take ownership and finish its resolved rollback metadata. Durable
  key aliases keep displaced processes from reclaiming the operation and replay
  the successor after finalization; a safe pre-activation abort removes the
  aliases with the fence. A compare-and-set transition grants exactly one request
  permission to issue the Worker PUT. That winner is bound to a request-scoped
  claim nonce: it can clear its own committed-but-lost claim response before the
  PUT begins, while an uncertain concurrent request cannot clear the winner's
  activation fence.

- **`.dev.vars` is now fully generated. Hand edits do not survive.**

  The file used to be three zones — an SDK section, a hand-edited section
  preserved across runs, and a store cache — which required a divider grammar, a
  dotenv parser to read the file back, and reconciliation between the two
  sources. That made `.dev.vars` a second source of truth, and historically a
  de-facto deploy input (docs/proposals/secrets-source-of-truth.md).

  Now it is a materialization: rewritten whole on every `dev`, `test`, `deploy`,
  and `secrets pull` run from platform values plus the app's secret store, with
  a header saying so. Nothing reads it back.

  **If you hand-edited `.dev.vars`, put required values in the store before
  updating** (`deepspace secrets set KEY=value`). The next dev/test/pull run
  overwrites the file. There is no legacy import or compatibility path; beta
  consumers must update their configuration.

  All Wrangler environments now share the one generated `.dev.vars`. Missing
  configs materialize as empty, so a successful refresh cannot leave stale local
  values behind.

  Also removed: `secrets upload` no longer strips a generated block (there is no
  block to strip — uploading the generated file is not a flow; use
  `secrets download` for backups).

### Patch Changes

- Remove stale lint suppressions from the Messaging and Documents feature
  sources so an app containing every public feature builds without unused-rule
  warnings.
- Support the maintained Node 22 (22.15+), 24, and 26 release lines. Reject
  end-of-life odd-numbered releases explicitly instead of allowing installs that
  can fail inside their frozen npm dependency resolver.

  Because npm treats `engines` as a warning by default, `create-deepspace` also
  checks the runtime before prompts, file copies, identity minting, or Git
  initialization. Help and version remain available for diagnosis.

- `deepspace pull` no longer traps an agent when local work is simply unpushed.

  Local-ahead — the ordinary state after `commit` — was classified as divergence.
  `pull` exited 2 with `actionRequired: true` and handed back
  `git merge refs/remotes/space/<branch>`, which answers "Already up to date" and
  changes nothing. An agent honouring the exit-2 contract re-ran `pull` forever;
  only `push` clears the state, and `push` was not the pinned action.

  It is now `status: "local_ahead"` on a successful (exit 0) pull. Human output
  names `deepspace push`, and JSON carries that same targeted push as its
  executable success action. `deepspace status` has always classified this
  correctly — the two now agree.

- Typo'd flags are now refused instead of silently ignored.

  citty hardcodes its parser to `strict: false`, so an unknown flag was never
  rejected — it was dropped and the command ran with the caller's intent
  discarded. `deepspace releases --limitt 1` swallowed the flag _and_ its value
  and returned every release with exit 0; `--jsonn` printed human prose to stdout
  while the caller waited for JSON. Unknown subcommands and bad flag _values_
  were already rejected; only flag names went unchecked.

  One check at the shared command boundary now rejects them with
  `code: "unknown_option"` before any side effect, naming the options that verb
  accepts. Aliases, hyphenated names, and `--no-<flag>` are unaffected.

- Collaborative apps no longer show stale data as live when the connection dies
  quietly.

  A peer that stops answering without closing leaves the socket ESTABLISHED — no
  packets are lost, so nothing retransmits, so no close event ever arrives.
  Measured against a peer frozen mid-conversation, an unprobed connection stayed
  open indefinitely. That is a hung Durable Object, a broken relay, or a
  blackholed path; the browser's `offline` event fires for none of them, because
  the machine's own network is fine.

  Everything downstream already handled this correctly and was simply never
  called: `useRecordContext().status` flips to `'disconnected'`, every live query
  resets to loading while keeping its records on screen, and the socket
  reconnects with backoff. The client now probes a connection once it has gone
  quiet and closes it after 45s of silence, so those run when they should.

  The probe costs nothing on the server: `BaseRoom` already registers a
  `WebSocketRequestResponsePair('ping','pong')`, so the Cloudflare runtime
  answers it while the Durable Object stays hibernated. An app already receiving
  updates is never probed. Liveness is probe-based: a quiet socket sends a ping
  after 15 seconds and closes only when that outstanding probe receives no
  inbound answer for a further 30 seconds. A backgrounded timer's first resumed
  callback therefore probes instead of falsely disconnecting a healthy socket.
  If suspension occurs after a ping was sent, the first delayed callback also
  discards that pre-suspension judgment and sends a fresh probe before applying
  the normal deadline.

## 0.17.0

### Minor Changes

- **`deepspace deploy --claim-released` lets a platform admin take a name still inside its 30-day cooldown.** Undeploying releases a hostname into a hold reserved for its previous owner, and `released_by` records the app's **owner** — not whoever ran the undeploy. So an admin taking down an abandoned or abusive app could not then put anything on that name for a month: the reservation belongs to the absent owner, and the admin's own app matches neither the releasing-owner nor the releasing-app leg that normally allows a reclaim. The name was stranded by the mechanism meant to protect it.

  The flag is explicit rather than an implicit admin bypass. The override is absolute — it beats a release made seconds ago and permanently discards the reservation rather than pausing it — so a routine admin deploy must not be able to seize a held name by accident. This is the same reasoning that makes a rename require `--rename`. Non-admin accounts are refused with `admin_required`, and because the tier lookup fails closed, a billing outage refuses rather than grants.

  Two records are written, because neither side knows the whole story: the deploy worker logs the acting admin (it cannot name the displaced owner, since only released rows carry `released_by` and no by-host lookup returns them), and the registry logs the displaced owner and the app that lost the name at the moment the row is replaced.

- **Removed: GameRoom, document mode, and the identity-migration wire.** These
  landed in #240 and #241 without a changeset, so this declares them rather than
  letting a release drop public exports silently.

  Gone from the public surface:
  - `useGameRoom`, and the `GameRoom` durable object with `GameRoomConfig`,
    `GamePlayer`, `UseGameRoomResult`, `Player`, and `GameInput`. No in-repo app
    used it, and it failed the authorization, hibernation, and scheduling
    invariants every other room holds. Use `RecordRoom` for shared state.
  - `CANONICAL_APP_IDENTITY_MIGRATION_ID` and the `MSG.GAME_*` protocol
    constants, which had no producer or consumer once the room went.
  - The RecordRoom document-mode migrations, verified unused across every repo
    in the org before deletion.

  An app that imported any of these will fail to build. Nothing in the templates
  or the feature catalog referenced them.

### Patch Changes

- Fix a set of version-control lifecycle and honesty defects found by
  black-box agent live-testing of multi-checkout collaboration — cases where
  a verb prescribed recovery that deterministically failed, reported work it
  did not do, or handed out a command that could not run where it pointed.
  - **Recovery actions execute verbatim.** Every `action.argv` that re-invokes
    this CLI is pinned to the running interpreter and entry (resolved through
    the `node_modules/.bin` symlink) instead of the bare word `deepspace`,
    which is not on PATH in a linked worktree, a bare clone, or an `npx`
    invocation. One door (`executableAction`) applies it to refusal actions,
    success-path actions, the unknown-command suggestion, and `deploy`'s own
    exit envelope; consumers must not assume `argv[0] === 'deepspace'`.
  - **A checkout can follow its own advice.** `deepspace clone`, `workspace
new`, `workspace attach`, `workspace sync`, and `workspace land` fill
    whichever half of the checkout's repo-local git identity is missing from
    the session token — previously the `git pull` a divergence refusal handed
    back (and any first commit) died on `unable to auto-detect email address`
    in a container with no global git config, or with a half-configured one.
    The divergence recovery also pins `git pull --no-rebase` (a fresh clone
    has no reconcile config) and exits 2 from workspace publishes exactly as
    it does from `push`.
  - **A second checkout of a landed workspace is no longer a dead end.**
    `workspace drop` cleans up the stale local worktree and branch of a
    workspace another clone landed or dropped — proving publication against a
    freshly fetched trunk tip when the landed ref is gone — and reports
    whether the remote drop actually happened (`json.remoteDropped`) instead
    of claiming a fresh drop on a replay. `workspace status` states the right
    fact per state (landed/dropped → drop cleans up; behind → fast-forward;
    diverged → integrate first) instead of prescribing a `workspace sync` that
    would refuse, and `--json` gains `syncRelation` so machine callers see the
    same distinction. `workspace land` and `workspace sync` on a finished
    workspace report `workspace_not_active` (with the `workspace drop` cleanup
    action) ahead of a checkout mismatch whose attach advice could not
    succeed; drop's own unsynced refusal stops prescribing the publish path
    once the workspace is finished — nothing can publish those commits, and
    the message says so. The server returns `workspace_not_active` (over the
    generic `conflict`) for sync/land/drop against a finished workspace — a
    worker-side change that reaches existing CLIs on deploy; no released CLI
    branches on the old slug, and this CLI tolerates both.
  - **`workspace attach` is idempotent.** Attaching an already-attached
    workspace points at the existing worktree instead of refusing
    `branch_exists` — reporting the LOCAL tip and, when it differs from the
    published tip, the recovery that relation actually admits (`workspace
sync` when ahead; `git pull --no-rebase` first when behind or diverged,
    since sync would refuse) — and re-materializes a worktree that `git
worktree remove` or a failed cleanup deleted.
  - **Land refusals carry their resume action, and a recorded merge is never
    reported as a bare failure.** `merge_conflict`, `conflict_markers` (now
    naming the offending files), `validation_failed`, and
    `validation_mutated_tree` carry the exact re-run action; when the trunk
    push succeeded and only recording the land failed, `land_unrecorded`
    states that the merge IS on trunk and resumes by re-running instead of
    implying nothing happened. When a concurrent land or drop finished the
    workspace mid-merge, land answers `workspace_not_active` at exit 2 with
    `pushed: true` and the `workspace drop` cleanup action — the merge is on
    trunk, and re-running could never record it.
  - **`status` stops labeling a feature branch's sync line "Trunk".** A
    non-default branch renders as `Branch sync`, and `json.trunk` gains
    `branch`/`isTrunk` (`isTrunk: null` when the default branch is unknown —
    GitHub-owned source or an unborn cloud repo — never a guess), so
    `trunk.state: "in_sync"` on a feature branch can no longer read as "local
    trunk matches cloud trunk". `activity` (CLI and dashboard) stops printing
    a fabricated "(0 files vs base)" changed-file count on workspace syncs —
    the event never carried one.

- `deepspace workspace drop` and `land` no longer treat the generic `conflict`
  error as "already finished".

  The server refuses a finished workspace with `workspace_not_active`; `conflict`
  was the pre-rename slug, and the CLI accepted both. Platform workers deploy
  ahead of the CLI release, so nothing still answers with the old slug — and
  `conflict` remains live for workspace-id clashes, which were being re-read as
  "already finished" instead of surfacing. An id clash now raises immediately.

## 0.16.0

### Minor Changes

- **Storage is now a per-ACCOUNT total, and the schedule is much larger.** free 128 MiB → **1 GiB**, starter 512 MiB → **10 GiB**, premium 2 GiB → **30 GiB**, admin 10 GiB → **100 GiB**.

  The number was per app, which meant an owner at their cap could create another app and keep writing — so the figure on the billing page described nothing enforceable. It is now the total across every app an owner holds: admission sums the owner's apps rather than only the one being written to, and a listing reports that same account total, so the number a caller sees is the number they are held to. Prefixes are swept concurrently, so the cost is the slowest single app rather than the sum, and an owner with one app — the common case — pays exactly what they did before. If the owner's apps cannot be enumerated the write fails closed, for the same reason a failed limit lookup does: an allocation that cannot be measured must not be written against.

  **The repo store no longer rides the customer schedule.** Git packs, retained rollback bundles, and stored deploy assets are admitted against a flat 256 MiB per app, the same for every tier. They are platform bookkeeping, not something a customer buys, so the tier was never the right input — and tying them together meant every raise to the advertised number silently multiplied platform-side storage per app. It also put a **billing lookup on the path of every push, deploy, and rollback**, one that could degrade and refuse the write outright; that failure mode is gone with it. An app that cannot fit its source plus a few rollback bundles in 256 MiB has something in the wrong place: user uploads belong in the app-files allocation, which is what the account schedule sizes.

  The dashboard advertised 5 GB while the platform enforced 128 MiB — a 40× overstatement that survived for months because they were two numbers instead of one. The billing page now reads the enforced schedule directly and cannot claim capacity the platform will not honor. `ACCOUNT_STORAGE_LIMIT_BYTES`, `storageLimitForTier`, and `formatBytes` are exported from the browser entry for that reason; `APP_STORAGE_LIMIT_BYTES` is renamed to `ACCOUNT_STORAGE_LIMIT_BYTES`, since what it means changed.

  **An app still on a legacy name-shaped id can reach its own files again.** `/internal/files/*` shape-checked the caller's `x-app-id` against the public-id pattern — a pre-filter STRICTER than the registry action it feeds, which matches `app_id` OR `resource_id`. Apps registered before canonical ids resolve fine in the registry but never got the chance to ask, so their file storage answered 401 with no way out: they cannot redeploy either. It also caught any app in the window between migrating and its next deploy, whose worker still carries the old id in its `DEEPSPACE_APP_ID` binding. Authority is unchanged — the constant-time HMAC, then a registry lookup that fails closed for anything unregistered.

  **A long AI stream is no longer cut short mid-completion.** The proxy's streaming pump ran inside `ctx.waitUntil` while the client read the other side of a TransformStream, and the runtime cancels that work on its own budget — independent of the client's read loop. Long completions died mid-stream, and the failure was invisible from the app: a cleanly ended SSE with no terminal event and no error. The body now pipes through an identity transform that accumulates the billing transcript as the client pulls, so delivery and invocation lifetime are the same thing and the stream lives exactly as long as its reader. Settlement moves to `flush()`: a completed stream settles actual usage as before, while a client that disconnects mid-stream leaves the bounded worst-case pre-charge standing rather than collecting a refund for bytes it never read — and upstream teardown stops paying the provider for tokens nobody receives.

## 0.15.0

### Minor Changes

- **`deepspace app migrate` is removed**, replaced by `deepspace app update` (below). It existed for one historical cutover — moving an app from a name-shaped id to a canonical one. The platform migration endpoints were subsequently removed too; an unexpected legacy-id app now requires operator-owned recovery. Do not downgrade to run the old command.

  A file that no longer exists now answers `404`, not the app's HTML. Deploys configured the asset layer with `not_found_handling: "single-page-application"`, so it answered EVERY unmatched path with `index.html` at 200 — correct for a client route, wrong for a file. A deploy replaces the hashed build chunks, so a tab still holding the previous `index.html` requested one and got HTML where JavaScript belonged: the script tag parsed it, failed, and the page went white with no error in any log, monitor, or network panel. The same answer went to agents probing `/llms.txt` and `/.well-known/mcp`, telling them the app publishes a manifest it does not have.

  The asset layer cannot tell a route from a file. The app's worker can — it knows `/assets/*` is build output — so the decision moves there: `not_found_handling: "none"` makes the binding report a real miss, and the worker serves the shell for a route or 404s a file. This is what the scaffold's route handler was written for all along; the config had made every branch under its `status === 404` check unreachable, which is why the reservation shipped in 0.13.0 never worked.

  **That setting is now the app's to declare, and the platform honors it.** It was first shipped as a platform-wide override, on the reasoning that every deployed app's catch-all already branched on a 404. The branch did exist — but it asked the asset layer for `/index.html`, which redirects to `/`. Under the old setting that branch never ran, so nothing showed; under a forced one it ran on every client route and handed the browser a 307 off the URL it asked for. An app built from the published template lost every deep link. A deploy that declares nothing keeps exactly the behavior the platform used to force, so an un-upgraded CLI cannot be broken by this release.

  `deepspace app update` moves an existing app onto it, and replaces `deepspace migrate`. An app's worker is a copy its author owns, so a platform change that needs different app code reaches nobody without a command that carries those copies forward. It pins the SDK, applies the source edits that are deterministic, and for anything it cannot safely touch prints the file, the line, and the change required — output an agent can execute. Edits still land when such a change is outstanding, because withholding them would leave the app on the old behavior for the sake of an edit someone else has to make; what is withheld is the recorded-as-done stamp, so the next run looks again. A version gap too wide to carry in one step points at the upgrade guide rather than half-migrating.

  Verified on a real deployment, not in a mock, on both sides of the change: an unmigrated `create-deepspace@0.13.0` app deploys and still serves `/settings` at 200 with no redirect, and the same app after `deepspace app update` answers a missing hashed chunk with `404 application/json` (including with a browser's `Sec-Fetch-Dest: script`), 404s `/llms.txt`, still serves `/favicon.ico`, and still serves a deep link at 200 **on the URL that was asked for**. A tab that outlives a deploy also now reloads itself once on Vite's `vite:preloadError` rather than leaving a lazily-loaded route silently dead.

  An app's `compatibility_date` is honored instead of silently discarded. `wrangler.toml` declared one runtime and the deploy hardcoded another, so local dev and production could run different semantics with nothing reporting the divergence. The declared date is now used, floored at the platform minimum (an app may move forward onto semantics it has tested, never backward onto ones the platform no longer supports) and clamped if it is in the future. The date a release ran on is recorded in its bundle, so a rollback restores that runtime rather than today's. The navigation-routing flag is now stated explicitly in the upload rather than inherited from that date, so the routing contract cannot be silently undone the day the platform pin moves.

  Make `deploy` and `rollback` mean it when they say a release is live. The wait polled with `fetch`, which keeps one connection alive — so every poll re-interviewed the single edge machine that answered first, agreed with itself instantly, and printed `Deployed!` while a quarter of fresh connections still served the previous release for up to 95 seconds. Each probe now opens its own connection and the wait succeeds only after ten independent ones agree. What cannot be verified is said plainly instead of implied: `--json` carries `serving: "confirmed" | "unconfirmed" | "unverifiable"`, and the human output distinguishes "the edge is still rolling this release out" from "serving could not be verified from here". The old reachability probe is gone — it proved the app answered, never which release did.

  Also: `collaborators accept` now points at `clone`, the command that works when you have just been granted access and have no checkout (`pull` failed with `not_in_app_repo`); accepting an invite you already accepted reports that you are a member instead of sending you to ask the owner for another billed invite; `collaborators add --json` no longer prints the invite's `/join` token into terminals and CI logs; `collaborators invites` drops the `appName` field that echoed the app id under a name it did not have; a refused upload carries its numbers into `--json` (`usedBytes`, `limitBytes`) rather than leaving them in prose; and `app undeploy` refuses with `not_app_owner` like every other owner-only surface.

  Internally, the routing decisions these fixes depend on now live in one place (`shared/app-routing.ts`) that the deploy worker, the CLI and the scaffold all read, replacing two hand-maintained copies of the reserved-path list whose divergence nothing would have reported. The scaffold's TOML cannot import a constant, so a test pins it to the same values — that is what keeps `deepspace dev` routing like production. `docs/platform/app-platform-contract.md` states the rules this boundary follows, including why a fix moves the platform to match app code rather than the reverse.

## 0.14.0

### Minor Changes

- Enforce the per-tier storage quota on app files. An app's file allocation had per-file, per-part and per-request ceilings but no admission against the owner's plan, so a free-tier app could hold 202 MiB against a 128 MiB limit with every upload reporting success and no surface reporting usage. One per-tier table now serves both storage allocations (the repo store and app files), and the shared files handler admits every write: the single-request upload before the put, a chunked upload against its declared total at init, and again against the object R2 actually assembled at complete — an over-limit assembly is deleted rather than left in the allocation. An upsert is charged only for the bytes it adds. The owner's tier caps the allocation whoever writes, so an app writing at runtime and its owner's CLI meet the same limit; a billing lookup that fails refuses writes rather than admitting unmetered storage, and leaves reads working. Refusals answer `storage_quota_exceeded` with the used and limit byte counts and name the recovery, and `deepspace app files list` now prints storage used against the limit.
- `deepspace deploy` and `deepspace rollback` now wait for the release they just published, not merely for the app to answer. Every upload carries a synthetic `/.well-known/deepspace/release.json` asset naming its own version, injected by the platform at upload time — so this holds for every app already deployed, including rollbacks of bundles that predate the change, with no app code and no redeploy. Cloudflare serves assets atomically with the version, so the CLI polls that path until the edge returns the release it shipped; without a stamp (an older platform, or a resumed activation) it falls back to the previous reachability probe. "Deployed!" previously landed 30–60 seconds before the edge agreed, which made any deploy-then-assert script flaky by construction.

  Invites can now be accepted without the emailed link. `deepspace app collaborators invites` lists the invites waiting for your signed-in email and `deepspace app collaborators accept <app-id>` accepts one — the same authority the `/join` page enforces (the signed-in email must match the invited address), reachable from a terminal. Previously an invitee who had never signed in could reach a state with no way forward: signing in did not grant access, the CLI said it would, and only the emailed link could complete it. That CLI message now describes what actually happens.

## 0.13.0

### Minor Changes

- Raise the app-files ceiling to 1 GiB by giving uploads the same streaming
  discipline the deploy asset transport already has.

  **The 25 MiB per-file limit was never a product decision.** It was the size of
  one HTTP request leaking out as a rule about files: the handler read the whole
  body into a ~128 MiB isolate, so the body had to be small. Media above it had
  nowhere to live — deploy assets refuse it by design and named app files as its
  home, which app files then also refused.

  **App files now upload the way deploy assets do.** A file above the part size
  is uploaded through R2's native multipart API: `POST /api/files/multipart` →
  `PUT /api/files/multipart/part` × N → `POST /api/files/multipart/complete`,
  with `DELETE /api/files/multipart` abandoning one. Every part is piped into R2
  through a `FixedLengthStream` with a required `Content-Length`, so the worker
  holds no more than one chunk of one part and a truncated body fails the write
  instead of landing a corrupt object. An upload is therefore bounded by the size
  of one request, never by the size of the file. There is no second upload
  system: the same shared handler, the same validation, and both mounts — the
  app's `/api/files` and the owner's `/api/app-files/:appId`.

  **A request that declares no length is refused with 411.** `Number(null)` is
  `0`, so a chunked body would otherwise clear every size bound as "empty" and
  then be read unbounded — and R2 cannot size a write it has no length for. One
  helper asks that question for the control bodies and the part path alike.

  **Small files still take one round trip.** The single-request path is
  unchanged below the part size, and its behaviour on both mounts is covered by
  regression tests.

  **Limits now say which question they answer.** `MAX_APP_FILE_BYTES` is 1 GiB
  (the largest file, checked at init against the declared total and again at
  complete against what R2 assembled — an over-ceiling object is deleted, not
  kept). `MAX_UPLOAD_REQUEST_BYTES` is 25 MiB (the most one request body may
  carry). `UPLOAD_PART_BYTES` is 20 MiB — both the part size init advertises and
  the hard bound on a part, because `MAX_UPLOAD_PARTS` (52) is computed against
  it: admitting 25 MiB parts would have made the real in-flight bound 1300 MiB
  while the advertised ceiling stayed 1 GiB.

  **Both clients chunk automatically, with peak memory bounded by the part size
  rather than by the file** — roughly 40 MB for a file of any size. `deepspace
app files put` reports progress per part; `useR2Files().upload` takes an
  optional `onProgress`. Parts go sequentially, a retryable failure (429, 5xx, a
  dropped connection) is retried **once** with the range re-read so a transient
  on part 40 of 52 does not discard a gibibyte, and any other failure abandons
  the session — so a retry never leaves parts holding the app's quota.

  `uploadBase64` stays single-request, and its client-side budget is now derived
  from the ENCODED body (`MAX_BASE64_UPLOAD_BYTES`, ~18.75 MiB decoded). Measured
  against the decoded size it accepted payloads whose bodies were a third larger
  than the server would ever take — a check that green-lit uploads guaranteed to 413.

  **Failures are classified rather than relayed.** R2's multipart error codes
  become honest answers: an unknown or expired session is a 404 telling the
  caller to start a new upload, parts that cannot assemble are a 400 saying why,
  a missing `Content-Length` is a 411, and only genuine faults are 5xx. A stolen
  `uploadId` is inert — every call rebuilds the R2 key from the caller's own
  authenticated prefix, so a session id from another app names an upload that
  does not exist there.

### Patch Changes

- Fix a set of CLI honesty defects found by two independent agent-experience
  audits against 0.12.0 — cases where a command reported something the platform
  was not doing.

  Patch, not minor: every item is a bug fix. `dev start --host` is a new flag on
  an existing command and `dev start --json` now emits the readiness envelope it
  already advertised, so neither adds API surface a caller could not already ask
  for. Under this repo's 0.x policy that stays patch-appropriate.
  - **`status` no longer reports a live release for an undeployed app.** Liveness
    came from the append-only release log, which undeploy never touches, so
    `status` printed `Live release #4 · https://…` while the edge 404'd and
    `app list` said `undeployed`. Both commands now read one predicate over the
    registry row, and `app list` reports collaborated apps (with a ROLE column)
    instead of hiding the apps a collaborator can deploy but never discover.
  - **The scaffolder persists its git identity.** It committed with `git -c
user.name=… -c user.email=…` and wrote nothing to `.git/config`, so the next
    commit — the one `deploy` requires — died `unable to auto-detect email
address` in any container without global git config.
  - **`--help` is ANSI-free when stdout is not a terminal.** citty freezes its
    no-color decision at module load and only honors `NO_COLOR=1`, never
    consulting stdout; help now renders through one chokepoint that strips SGR
    escapes off a pipe and leaves a terminal coloured.
  - **`dev start --json` emits a real readiness envelope** the moment the port
    answers, instead of nothing until the server exits, and gains `--host` for
    binding a specific interface. Readiness and the port pre-check both probe by
    CONNECTING: a bind probe answers "can I bind this address", which on
    macOS/BSD reports 127.0.0.1 free while vite serves 0.0.0.0. A readiness
    timeout emits `{"ok":false,"code":"dev_server_not_ready"}` rather than
    nothing, so a caller blocking on that line cannot hang.
  - **Generated apps reserve the agent-protocol paths.** `/llms.txt`,
    `/llms-full.txt`, `/.well-known/mcp`, `/.well-known/mcp.json` and
    `/.well-known/mcp/*` fell through to the SPA shell, so a probe read the
    homepage as a published manifest. They are now in the deploy worker's
    `run_worker_first` baseline (the only list that reaches Cloudflare — the
    CLI's reserved list is a deny-list that strips them from the app's own
    config), and the app's static fallback withholds the SPA shell for them. A
    real `public/llms.txt` still serves; only the shell standing in for one is
    withheld.
  - **`rollback` waits for edge propagation** before claiming a URL is live,
    reusing deploy's wait — now one implementation instead of a private copy.
  - **Human output no longer prints raw user ids.** `whoami` drops the `UserID:`
    line, `releases` resolves actors to emails the way `activity` already did,
    and the on-behalf deploy notice states the attribution instead of an opaque
    id. All ids stay in `--json`.
  - **The oversize-push recipe works when executed verbatim.** `git reset --soft`
    leaves the file STAGED, so the documented re-commit re-added the same blob and
    the push failed identically; the recipe now includes `git restore --staged`,
    says to MOVE the file out of `public/` (`.gitignore` does not exclude it from
    the deploy bundle), and is covered by a test that runs the shipped sentence
    step by step against a real remote.
  - **Deploy validates asset sizes before it pushes.** The commit reached the
    cloud repo first, so the repo advanced onto a release the platform then
    refused; the refusal now names the file and its size in MiB rather than a
    SHA-256 and a raw byte count. Only the PER-FILE cap is checked locally, from
    a constant the deploy worker now imports rather than duplicates — the
    per-deploy total is env-configurable and the server dedupes by content hash
    before summing, so any local total would be a guess doing different
    arithmetic.
  - **`app files put` refuses active content.** `.svg`, `.html`, `.htm`, `.js`
    and `.mjs` were missing from the type map, uploaded as
    `application/octet-stream`, and were stored past the server's own 415 — then
    served un-renderable under a `✓`. `.xml` is deliberately left unmapped so
    sitemaps and RSS feeds keep working exactly as before.
  - **`app files rm` reports a missing key** instead of printing `✓ deleted` for
    a name that was never there. The HTTP contract is unchanged — DELETE stays
    idempotent and 200, now carrying `existed`, because deployed apps branch on
    `res.ok`; the refusal is the CLI's. The oversize code is `too_large` on both
    sides rather than `too_large` from the worker and `file_too_large` from the
    client for one condition.
  - **Ceilings appear in `--help`** for `deploy`, `push` and `app files put`,
    read from the constants rather than restated.
  - **The unknown-command suggester withholds the executable action when the
    guess is destructive** (`rm` → `app files rm`, `delete` → `secrets delete`).
    The suggestion still appears in prose; only the runnable `action` is dropped.
    A whole command passed as ONE quoted token (`deepspace "auth whoami"`, which
    a shell that does not word-split produces) is now recognised and reported as
    a quoting problem, instead of suggesting a command that printed identically
    to what was typed.
  - **The collaborator-invite failure says what actually failed** — email
    delivery, with the invite not created and the charge voided — instead of a
    bare "please try again" that loops forever on an undeliverable address.
  - **MCP discovery advertises every protocol version the handshake accepts.**
    The handshake itself was already spec-correct (a server MUST echo a supported
    version the client requested); the card advertising only the newest is what
    made the two look like they disagreed.

- Fix documentation sites built from MDX crashing on every client-side navigation. The article's imperative code-block pass reparented each compiled `pre`, which is invisible on the default runtime but detaches a React-owned node on the executable runtime, so the next route swap threw `NotFoundError: The node to be removed is not a child of this node` and tore the article out of the page. The prose subtree now names its single writer and the imperative passes cannot reach React-rendered nodes; MDX gets the same code-block and tab-group structure from React components instead. Also fixes the assistant chip clipping the site name, the search trigger rendering at the reading scale instead of the chrome scale, and the theme control buttons sitting edge to edge.

## 0.12.0

### Minor Changes

- Add `deepspace app files`, and make oversized pushes and uploads fail fast with
  advice that actually works.

  **`deepspace app files put|list|get|rm`** reaches the app's own R2 allocation
  from the command line, so images and media can be published without a deploy
  and without living in Git history. Keys are relative to the app; the platform
  owns the physical prefix and validates every key against it.

  **An oversized push now fails fast and correctly.** A push refused with HTTP
  413 is classified as `push_too_large` and names both ceilings (20 MiB per file,
  32 MiB of compressed history per push) plus any local file over the per-file
  cap. `deploy` renders a rejection with the same text `push` does, instead of a
  bare "resolve the rejection".

  **The oversize remediation was wrong and is fixed.** It advised `git rm
--cached` + `.gitignore` + re-commit, which provably does not work: the blob
  stays reachable from the earlier commit and the push is rejected identically.
  The advice now says to drop the file from the commits that carry it (or rewrite
  history if already pushed), states that untracking alone is insufficient, and
  points at `deepspace app files put` as media's real home. Both facts are
  covered by tests that run the recipes against a real repository.

  **No git call can hang the CLI any more.** `deepspace deploy` could sit
  silently for minutes on a push the server had already refused, because
  `spawnSync` had no timeout. Every git invocation is now bounded, and the
  deploy push-retry loop has a wall-clock budget rather than only an attempt
  count.

  **Oversized uploads report their size, not a JSON parse error.** An upload past
  the edge's request limit returns an HTML error page; the browser hook and the
  CLI both fed that to `JSON.parse` and surfaced `Unexpected token '<' … is not
valid JSON`. Both now read failures as text first, and the 25 MiB ceiling is
  enforced by the shared upload handler — so it binds hand-rolled requests too,
  not just SDK callers. `uploadBase64` is measured on decoded bytes.

  **The owner files endpoint takes human sessions only.** `APP_OWNER_JWT` (the
  ten-year token baked into every deployed app) and preview tokens carry the
  owner as `sub` on the same issuer and audience, so they verify. Accepting them
  would have let any app read and overwrite files in every other app its owner
  has; tokens carrying a `scope` claim are now refused there.

## 0.11.0

### Minor Changes

- Replace the base64 deploy asset transport with a content-addressed one. The CLI now hashes the build output locally, asks the platform which files it is missing, and streams only those into the app's release store; unchanged files are never re-uploaded, and no deploy ever serializes its assets into a JSON payload. This removes the "Worker exceeded memory limit" failure that surfaced as a misleading Cloudflare-incident 503 on asset-heavy deploys, and a deploy-service resource limit is now reported distinctly from a genuine Cloudflare API incident.

  **This release requires an updated deploy service and is required to deploy.** The old grouped-upload endpoints are gone: an older CLI is answered with a clear "update to deploy" instruction, and this CLI refuses to start against a deploy service that does not advertise the new transport. Releases recorded before the cutover can no longer be rolled back to directly — redeploy that commit instead.

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
