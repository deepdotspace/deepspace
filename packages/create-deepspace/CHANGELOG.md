# create-deepspace

## 0.27.1

### Patch Changes

- Merge the starter template's drifted `vitest.config.ts` override into the base template's config: starter apps now keep the `@` path alias (its absence broke unit tests importing `components/ui/*`) and run both `*.test.*` and `*.spec.*` unit files. One config, both templates.

## 0.27.0

### Minor Changes

- Every confirmed finding from the v0.26.0 three-lane AX pass is fixed. First-use healing: an INTERRUPTED dependency install no longer reads as ready (npm writes `node_modules/deepspace/package.json` long before it links `.bin`; readiness now also requires no started-without-done sentinel evidence, so a killed install retries on the next command instead of failing later as `vitest: not found`). A committed `__APP_ID__` placeholder now refuses with its own diagnosis (`placeholder_committed`, action `deepspace app init [--env <name>]`, scoped to the SECTION being targeted so a real top-level id with a committed staging placeholder heals the right thing) instead of "this does not look like a DeepSpace app" — the state every GitHub-lane scaffold enters by pushing itself to GitHub; the plain `app_not_initialized` refusal now ships the `app init` action too. GitHub-inferred apps: `pull`, `clone`, and `workspace new` on an intentionally-empty cloud repo now consult the release ledger (ledger evidence ONLY — a mirror remote on a never-released app is not evidence and does not refuse) and refuse `source_managed_by_github` naming the repository — previously all three prescribed `deepspace push`, the PERMANENT DeepSpace claim; `pull` and `workspace new` also no longer write the `space` remote or the checkout's git identity before refusing, and `status` stops inventing a cloud trunk for such checkouts (`trunk.state: "external"`, marked `inferred`). `deploy --json` carries the source evidence the human stream announces (`source: {provider, repository?, inferred?} | null`). Suggestions: `auth status` now suggests `status` (the shallowest exact match wins; requiring a globally unique leaf sent it to the fuzzy — and destructive — `logout`). Collaboration: a never-deployed app's `owner_jwt_missing` tells the collaborator the owner must deploy once first (not "redeploy" an app that never deployed); `undeploy` checks ownership before its consent gate (a collaborator is no longer told to re-run the most destructive verb with `--yes`); collaborators can READ `app collaborators list` (mutations stay owner-only; PENDING invites stay visible to the owner alone — unaccepted invitees' emails are not roster data); deploy tells a collaborator they are shipping someone else's app; the `not_app_owner` hint no longer presumes the reader is a current collaborator; `transfer offer --json` carries `onAcceptance` (the loss-of-all-access consequence only the human path printed); deleting a developer account now cascades to the test accounts they created (their user rows and signup attribution included). Secrets: `deepspace secrets set KEY --stdin` pipes a value without putting it on argv (the CLI's own rule, previously satisfiable only via `secrets upload`); an empty piped value refuses `empty_input` rather than silently storing "". Tests: `test run all` re-asserts the port between vitest and Playwright so a winding-down runtime server is never adopted (the cold-start phantom-404 race), and the default suite's skipped-specs correction prints on stderr where captures see it. First-use registration announces the ACCOUNT EMAIL, not "your account". `pull`'s unborn-checkout advice names `git reset --mixed` instead of steering into a divergent second root; the deploy-lock refusal says to judge liveness by start time, not pid (container zombies read as alive). Scaffolder: `create-deepspace` no longer registers at scaffold time — every app registers on first use, logged in or not, so a spare `npm create` no longer burns a quota slot (`--no-register` is a deprecated no-op — it asks for what now always happens, and refusing it would exit-1 existing scripts); `--yes`/`-y` are accepted as no-ops instead of exiting 1; the template's toast viewport no longer swallows clicks under it (`pointer-events-none`); the template's `/api` 404 guard answers JSON on every method, not only GET; the template's collab spec skips itself (naming `test accounts create --password-stdin`) when the account pool is empty instead of failing a cold machine's first run.

### Patch Changes

- Widen the deploy app-id guard's documentation exclusion to the whole
  `_documentation*` output family (`_documentation/` and, for root-mounted
  docs sites, `_documentation-root/`): 0.26.2 excluded only the compiled MDX
  chunks, but the prerendered per-page HTML and the root-mounted variant
  carry the same `__DEEPSPACE_APP_ID__` sample text and still refused the
  deploy. The subtree is generated entirely by the SDK's docs builder;
  app-owned assets stay scanned.

## 0.26.2

### Patch Changes

- Fix the deploy app-id guard refusing sites whose documentation merely
  mentions the pattern: compiled `documentation-page-*` MDX chunks are
  excluded from the `__DEEPSPACE_APP_ID__`/foreign-id scan, since their code
  samples carry those tokens as text, not evaluated identifiers. The
  documentation runtime's own chunks stay scanned.

## 0.26.1

### Patch Changes

- Remove the unused platform-owned conversation, directory, and inbox stack,
  including its hooks, schemas, routes, bindings, Durable Object class, and
  dead client platform context/WebSocket helpers.

  Make the bundled messaging feature honest and smaller by supporting public
  channels only, confirming membership writes, and removing duplicate multi-chat,
  DM, private-group, invitation, and unread-state implementations. Remove the
  overbuilt sidebar feature and reduce search to a controlled inline component
  plus local ranking.

  Make generated Playwright runs own their test server and refuse busy ports
  (`port_in_use`, after a bounded grace for a server still shutting down), gate
  suite readiness on the auth plane, settle screenshots before capture (with
  opt-in `--wait-for-selector`), add the router hydration fallback, bound deploy
  JSON progress, and label `app usage` as account-wide.

  Migration for existing apps: removed `deepspace` exports include
  `useConversation`, the `client/directory` hooks (`useConversations`,
  `useCommunities`, `usePosts`), the client platform context
  (`PlatformProvider`, `usePlatformWS`), `ChannelInvitation`,
  `CHANNEL_INVITATIONS_SCHEMA`, `CONVERSATION_SCHEMAS`, `VOTING_SCHEMAS`,
  `DIRECTORY_SCHEMAS`, and the messaging display utils
  (`formatMessageTime`, `groupReactionsForMessage`, `parseMessageMetadata`, …).
  Apps that installed the pre-0.27 messaging feature should delete the copied
  `chat-multi/` components, `ChatMultiPage`, and `useMultiChannel` (they import
  the removed exports), and drop `channel-invitations` from their schemas. The
  bundled `channels` schema now admits only `type: 'public'`: existing
  `private`/`dm` rows keep reading but fail validation on writes that echo the
  old value — delete those rows or keep an app-local schema that still declares
  them.

## 0.26.0

### Minor Changes

- Source authority is inferred from use, never registered, and the 0.25.0 AX-pass defects are fixed. Nothing is declared "at the beginning": the `source_unclaimed` deploy refusal is gone — an unclaimed app whose checkout has a GitHub remote deploys as GitHub automatically (no git gates, no credential probe; `github_credentials_required` no longer exists), and each release records the observed repository. The first `deepspace push` (or an unclaimed app's deploy sync) claims DeepSpace source at the git receive path, once, permanently — and now says so on stderr at the moment it happens. The claim fires on the pack POST rather than the ref advert, so a `git push --dry-run` or an abandoned push never pins the app — and an admin-tier push to an unclaimed app refuses (`admin_cannot_claim`): support must neither claim an app nor create history on an unclaimed one. `deepspace app source` is now read-only (`source_inferred` refuses the old setter, and reporting an unregistered checkout never mints); the server's `POST /source` route and the transfer protocol (ref/release proofs, `github_push_required`, the transfer-preparation `source_changed` checks — deploy's own `source_changed` race check remains — the owner-only import receive path and its `X-DeepSpace-Source-Revision` header) are removed. A claimed GitHub app's stale `space` git remote is now removed by `deploy` (the old claim command did this). Releases also record the dirty flag on commit-bearing `--no-push` deploys (`commit abc123 (dirty worktree)`), and a rollback carries its TARGET release's source evidence and dirty flag instead of losing them. App registration is also no longer an upfront step: apps register on FIRST USE. Any verb that USES the app — `secrets set`/`upload`/`pull` before the first deploy, `dev start`, `test run`, `deploy`, and `push` once the repo has commits — mints and stamps its id through the one resolver chokepoint when wrangler.toml has none (same registration `app init` performs, announced on stderr with the plane and account; the initial scaffold commit is made by `app init` and `deploy` only). A wrangler.toml whose COMMITTED content still carries the `__APP_ID__` placeholder refuses (a shared repo must not mint one app per clone), a typo'd `--env` name still refuses (`no_app_id_for_env`) — minting only fills a declared env block or the top level — and a malformed existing id still refuses (`invalid_app_id`), never minted over. Healing is scoped twice: only a wrangler.toml that DECLARES `DEEPSPACE_APP_ID` (the scaffold's placeholder) can mint — an unrelated Cloudflare Workers repo refuses as before — and only the verbs whose purpose is building or using the app register (`deploy`, `dev`, `test`, `push`, and the `secrets` WRITE verbs); read and ownership verbs (`secrets list/get/download`, `logs`, `releases`, `collaborators`, `transfer`, …) keep the `app_not_initialized` refusal rather than consuming a quota slot as a side effect. Only `app init`/`deploy` create the initial scaffold commit (the resolver never authors git commits). Dependencies also install on first use: a fresh clone's `dev`/`test`/`deploy`/`add` runs the detected package manager itself (streamed to `.deepspace/install.log`, bounded at 5 minutes, retried on the next command after a failure, `DEEPSPACE_NO_INSTALL=1` restores the old `deps_missing` refusal — note this includes workspace worktrees, which get their own install). Collaborator pushes now claim DeepSpace source like the owner's (the old owner-only claim would have left collaborator-built apps unclaimed — with claiming and pushing at the same receive path, an app with cloud history is always claimed), and inferred-GitHub evidence travels as its own field so a 0.25.0 worker's stale-base guard is never skipped by it; the retired `POST /source` answers 410 `source_inferred` instead of a misleading 404. `npm create` → any command works with no intermediate step; a logged-out scaffold exits 0; `app init` remains the explicit spelling and the only path that can replace an id (`--new-id`). `app undeploy` automation must pass `--yes` (the repo's own reaper and harness scripts updated). Consent: `app undeploy` under `--json` or a non-TTY stdin now refuses `confirmation_required` without `--yes` instead of treating the command as consent. Releases: a deploy records `sourceDirty` — whether the shipped working tree carried uncommitted changes — and `releases`/`status` label a dirty GitHub-source release (`GitHub · owner/repo, dirty worktree`), so a rollback no longer picks between clean and dirty releases blind. `push` over a dirty worktree now warns and carries `uncommitted` in `--json` (push publishes committed history only). `test accounts create` accepts `--password-stdin` (argv passwords discouraged). `test run` refuses a zombie dev server (`port_in_use`, bounded wait) instead of letting Playwright adopt a dying one mid-run. `not_app_owner` refusals name the recoveries (ask the owner, `app transfer offer`, `app init --new-id`). An unknown subcommand that exactly names a command elsewhere in the tree is suggested there (`auth status` → `status`, not `auth logout`).

## 0.25.0

### Patch Changes

- Raise the hono floor to ^4.12.34, the minimum release carrying the fixes for the 2026 hono security advisories (CORS credential reflection, bodyLimit bypass, cookie-name validation, and related middleware issues), in the SDK's dependencies and the scaffold template.

## 0.24.1

## 0.24.0

### Patch Changes

- Use Generouted's lazy router entry in generated apps so route modules are code-split. Public top-level pages no longer preload the authenticated and collaborative route graph in their initial client bundle.
- Fixes from the v0.23.2 production AX pass. Server: the `user.list` assistant tool now returns exactly what the socket roster gives the caller (admins full rows through the read policy; everyone else the public identity projection, honouring `read: false` and `roster: 'read-policy'`; app actions keep full rows) — it used to hand every member every user's email; the public identity projection now carries `lastSeenAt`, so `usePresence()` works for non-admins (it was always offline for everyone but the owner); `timestampTrigger` writes canonical epoch seconds on a `storage: 'number'` date/datetime column instead of an ISO string that stored the year or milliseconds inconsistent with explicit writes; an empty string written to a text column is stored as `''` (it was folded into NULL, so the field read back absent and a `default: ''` never materialized); `where` on `records.query`/`deleteWhere` refuses arrays and non-objects at the one shared chokepoint; `deleteWhere` authorizes with delete permission independently of read permission; the client's `writableFields` refusal names the role and field again. CLI: `deploy` states on both surfaces that a rename does not carry the display name (`src/constants.ts` and `wrangler.toml [vars] APP_NAME`) and the `--rename` success envelope carries `renamedFrom`/`staleDisplayName`; `collaborators add` discloses that a collaborator can read and change every secret (`grants` in `--json`); the false "attributed to the app's owner" warning on collaborator deploys is gone (the ledger records the collaborator); `app source github` removes a stale `space` git remote (`spaceRemote` in `--json`), refuses stale import writes after an authority flip, rechecks GitHub after import, and preserves a successful flip when local remote reconciliation fails; `push`/`pull`/`clone` share one GitHub-source refusal with `repository` and `appId` as fields (`apiFetch` now keeps every server-provided field on `ApiError.details`); `push`'s uninitialized-scaffold refusal is `actionRequired` (exit 2) like `deploy`'s; `releases`/`status`/`activity` name a GitHub-source release's source instead of "(no source recorded)"; a GitHub-source deploy reports its branch and whether the tree was dirty (both surfaces); `app update` is now a successful read-only guide tied to the running CLI version: it reads only explicit app manifests and never rewrites source, stamps migrations, runs an installer, scans unrelated packages, imposes DeepSpace Git transport checks, or treats outstanding work as a command failure; local/file/workspace/VCS SDK specs report `dependency_unverified` instead of a false aligned state, and malformed migration ledgers refuse with `invalid_migration_manifest`; `test run --json` routes the Playwright dependency preflight to stderr through the same chokepoint as the suite and says up front when it will run `apt-get`; the `unknown_suite` refusal mentions `--grep` and single-spec paths; `test accounts create` no longer prints the password (it is saved locally; `list --reveal` shows it); `ActionTools` gains `deleteWhere` (template + upgrade guidance). Deploy locking no longer reclaims stale paths automatically, and release callbacks delete only the lock they own. Scaffolder: `create-deepspace@X` pins `deepspace` to exactly `X` (a caret let a pinned scaffolder install the newest SDK) and prints the SDK version it installed.

  Second round (wave 2 of the pass — recovery, upgrade, observability). CLI: a present-but-malformed `DEEPSPACE_APP_ID` is refused as `invalid_app_id` at the one id resolver (it was reported as "no app id" and the offered `app init` orphaned the app; `app init` now refuses to overwrite it without `--new-id`); the "no app dir" vs "app dir without an id" states get one code each (`not_in_app_repo` / `app_not_initialized`) across `deploy`, `secrets`, `test`, `dev`; `secrets` and `auth login` refusals go through the shared envelope (`not_authenticated` with its action, `network_error` naming the service and env var, `file_not_found`, `invalid_credentials`); `not_authenticated` names the selected plane vs the plane holding a session (`DEEPSPACE_ENV`/`DEEPSPACE_AUTH_URL`) and the headless login form; `push`/`pull`/`deploy` refuse `merge_in_progress` mid-merge instead of pushing the pre-merge commit; `deploy` takes a local `.deepspace/deploy.lock` (`deploy_in_progress` names the other run) so two deploys in one directory no longer race on `dist/`, `release_in_progress` explains itself and carries a retry action, `forbidden` names the signed-in account and the app, and after the edge confirms a release `deploy` wakes the worker once; `undeploy`'s confirmation says what is destroyed (the app's Durable Objects: records, messages, canvas state, cron history — the old sentence said "data stays") and what stays (secrets, registration), names the app, and a second undeploy reports `alreadyUndeployed`; `logs` on a never-deployed app refuses `app_not_deployed`; `app init --json` reports the plane as `env` (the wrangler slot is `wranglerEnv`); `test accounts list --json` prints passwords only with `--reveal`; `status --help` names `env`/`services`; `integrations invoke` refuses a paid call outside a terminal or under `--json` without `--yes` (`cost_confirmation_required`; the interactive prompt defaults to No) and `integrations info` synthesizes an example body from the schema's required keys; `app update` reports guidance for the build-injected app id and action-route bearer guard without mutating the checkout; `app init`'s `app_not_registered` refusal ships the `--new-id` action; `workspace land` pins its follow-up to the surviving primary checkout instead of the managed worktree it just removed. Server: a cron schedule arms on the worker's first request (`armCronRoom`, wired in the template) instead of waiting for its Durable Object to be fetched by a visitor, and rejected or non-2xx wake attempts remain retryable; cron and job runs log one structured line each; the template's `app.onError` logs a thrown error's message (Hono's default rendered only the stack frames, so `deepspace logs` never carried it). Platform (ships with the next worker deploy): a created-never-written secrets config answers `{}` instead of "Project DEK not found"; non-request log invocations (alarms) are labelled with their entrypoint; the integrations catalog discloses the customer price after markup and currency conversion (`null` for metered `per_actual_cost` endpoints, `variesWithInput` where multipliers apply), and `integrations list`/`info`/the consent prompt label an input-dependent figure as a base rate that can move lower or higher instead of falsely calling it a floor. Template: the action route logs `[action] <name> caller=<userId>` (the platform request log carries no user), with upgrade guidance for existing apps.

## 0.23.2

### Patch Changes

- Fixes from the v0.23.1 production AX pass: `create-deepspace` exits nonzero when its registration step fails (and says "scaffolded, no app id yet" instead of "is ready"), renders the CLI's refusal sentence instead of a raw JSON envelope, offers `auth login` only when the failure was a missing login, names the account and plane it registered on, and takes `--no-register` (plus a hint that `--yes` is unnecessary); `records.query` refuses a `where` key that names no field (an ignored key returned the whole readable collection as if filtered — the same class `deleteWhere` refuses); `deepspace pull` checks the cloud repo before writing the `space` git remote, so a GitHub-source refusal no longer leaves the push-capable remote behind; `deploy --json` reports a stray server refusal under its real code instead of `deploy_failed` wrapping the JSON as text; `app undeploy` confirms at an interactive terminal (`--yes` skips; scripts and `--json` are never prompted); `test run --json` streams the suite on stderr so stdout is the single JSON line; `status` always states the environment (`env`, `services` in `--json`); the rename prompt says the display `APP_NAME` does not travel, and lives in one place for both the pre-build and commit-time paths.

## 0.23.1

### Patch Changes

- Chat writes can no longer resurrect a deleted chat, the delete cascade is bounded, and cookie-only server-action calls get a 401 instead of a 500. `updateChat` and `appendMessage` now re-check the chat through `getChat` and return `false` instead of writing when it is gone (`records.update`/`records.create` are upserts, so an unguarded post-stream write recreated a deleted chat as a title-less ghost). New `records.deleteWhere` tool on the room tools API — `{ collection, where, limit }` → `{ deleted }`, bounded per call, same delete permission check as `records.delete` and refusing the whole page if any match is denied — lets `deleteChatCascade` spend one subrequest per page instead of one per message. The scaffolded `POST /api/actions/:name` reads the bearer token defensively: an authenticated caller with no `Authorization` header is now refused 401 rather than throwing, and the file carries the trust-model note that action tools execute as the caller with RBAC off.
- CLI honesty pass: `deepspace test run`'s default suite now names every spec file it skipped (prose line + `skippedSpecs` in `--json`); `push` refuses a GitHub-sourced app in its preflight, naming the repository, instead of reconstructing a repository-less sentence from git's discarded 422; `push`'s `no_commits` refusal and `app init --new-id` both name their next step; and a scaffold whose identity registered no longer tells you to `auth login`.
- Verification-pass fixes: `records.deleteWhere` refuses a `where` whose keys name no field (an unknown key used to be silently dropped, deleting an unfiltered page), refuses schemaless collections and non-numeric limits, and pages after the RBAC read filter; a users schema with an explicit `read: false` keeps an empty roster for that role, and a role change now refreshes every connected roster; the scaffold's chat route stops (rather than continuing) when a mid-stream delete makes `appendMessage` return `false`, and `PATCH /api/ai/chats/:id` answers 404 for a write that never landed; the build plugin's `.dev.vars` sweep clears every worker dir before reporting an unsafe one; a missing `wrangler.toml` is `not_in_app_repo` with a remedy instead of `invalid_config`, and `detectAppName` shares the one reader; `push`'s `no_commits` names the `__APP_ID__` case only when the placeholder is present (with the `app init` action); `app init` ships a `git commit … wrangler.toml` action when it did not commit; secrets refusals keep the server's `code` in `--json`; `app list` shows a renamed app's reserved old name.
- AX-pass fixes: `secrets` reads on an unregistered app id refuse `app_not_registered` instead of answering an empty list; the scaffold registers its AI chat routes only when the copilot schemas are present (they could only 500 without them) and names the valid model ids (`unknown_model`) on a bad `modelId`; `create-deepspace` says which plane it registered the app on and which id; deploy/push/pull/update/workspace share one `not_in_app_repo` sentence; `lintSchemas` warns when a role uses the `'team'` level with no `team_members` collection; an implausible command guess is no longer handed back as an executable `action` and `logout` counts as destructive; `transfer accept` names collaborators inherited from the previous owner; `secrets set/upload/delete --json` carry `appliesAtDeploy: true`; `rollback --help` states secrets are kept; `app update` leaves a `file:`/`link:` deepspace spec alone.

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

## 0.21.0

### Patch Changes

- Brandable AuthOverlay (title/description/logo props, `--ds-auth-backdrop` var), an in-page signed-out fallback for the scaffold's protected routes, Modal long-string wrapping, integration-test catalog error/retry states, and a token-styled cron log page.
- Fix agent-reported workspace continuations, file metadata and generated file-manager behavior, collaborator recovery guidance, documentation theme strict mode, and source-mode guidance.

## 0.20.0

## 0.19.5

## 0.19.4

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

### Patch Changes

- Support the maintained Node 22 (22.15+), 24, and 26 release lines. Reject
  end-of-life odd-numbered releases explicitly instead of allowing installs that
  can fail inside their frozen npm dependency resolver.

  Because npm treats `engines` as a warning by default, `create-deepspace` also
  checks the runtime before prompts, file copies, identity minting, or Git
  initialization. Help and version remain available for diagnosis.

- Declare the scaffold root as the pnpm workspace package so pnpm 11 accepts the
  generated `pnpm-workspace.yaml` while applying its required build allowances.
- Preserve user-owned content during in-place scaffolding. Placeholder
  substitution now happens in the staged template before it is merged, existing
  Claude skill directories are refused rather than recursively replaced, and
  mixed-source effective Git identities retain their real name and email.

## 0.17.0

## 0.16.0

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

### Patch Changes

- Fix `pnpm install` failing immediately after scaffolding on pnpm 11. That version defaults `strictDepBuilds` to true, so an install that silently skips a dependency's build script exits non-zero (`ERR_PNPM_IGNORED_BUILDS`) instead of warning — and a new app needs two of them: esbuild's native shim for Vite, and workerd, the Workers runtime `deepspace dev` runs on. The scaffold now ships a `pnpm-workspace.yaml` declaring exactly those two under `allowBuilds`, which is the only place pnpm reads build allowances from; npm and bun ignore the file. The template's `allowScripts` field is deleted with it: no package manager has ever read that key, so it described a guarantee nothing enforced.

## 0.13.0

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

## 0.9.0

## 0.8.2

## 0.8.1

### Patch Changes

- Align the CLI's esbuild dependency with Vite 8 and pre-approve the required esbuild and workerd install scripts in generated npm 11 apps.
- Make Codex, Claude, and ordinary Git worktrees first-class. DeepSpace now validates Claude paths against Git metadata, isolates ports for every linked checkout, retains externally managed worktrees, creates managed worktrees outside the invoking client checkout without shared dependency links, refuses lineage-losing detached deploys, and scopes ephemeral credential helpers per worktree. Fresh scaffolds finish dependency installation before their initial commit, preserve existing agent metadata and launch configuration, and keep neutral agent instructions canonical.

## 0.8.0

### Patch Changes

- Install Framer Motion only when adding the landing-page feature instead of including it in every new app.
- Windows support fixes. `deepspace create` now runs the scaffolder correctly (it exec's `npx.cmd` via cross-spawn instead of exiting 1 with no output) and reports a spawn failure instead of swallowing it. Scaffolded dependency installs are reliable and observable on Windows: the install runs in the foreground rather than a detached worker that the terminal's job object could kill mid-install, and the log-tail hint is PowerShell-aware (`Get-Content -Wait`) off Windows and `tail -f` elsewhere. CLI error paths (workspace/deploy/pull/push/clone and any escaped error) now stop the active progress spinner before exiting, so an expected error exits cleanly instead of aborting with a libuv assertion. Cross-platform path and process spawning throughout.

## 0.7.0

### Minor Changes

- Rework the scaffolder around a clean starter and a template system.
  - The starter template is rebuilt on a Base UI-backed primitive kit (Dialog/Modal, Select, DropdownMenu, Popover, Tooltip, Tabs, and form controls) with a minimal, unopinionated shell, so scaffolded apps start from a neutral base and design their own look.
  - `npx create-deepspace` now assembles apps from a shared base plus per-template overlays. Choose a template with `--template <name>` (or `-i` for an interactive picker); `starter` remains the default.
  - New `copilot` template: a three-panel shell (collapsible sidebar, a main content panel, and an AI chat dock) with light and dark themes.

### Patch Changes

- Condense the scaffolded CLAUDE.md (starter and copilot templates) to a lightweight pointer at the deepspace skill — the single source of truth for agent instructions. The removed sections (build workflow, static vs dynamic pages, UI placeholder rules) all live in the skill's SKILL.md and references; CLAUDE.md keeps the skill-loading block, a short "About this project" (including which template the app was scaffolded from), and "Project commands".

## 0.6.2

### Patch Changes

- RecordRoom now gates its HTTP debug API (`/api/debug/*`) behind `ALLOW_DEBUG_ROUTES` at the Durable Object's own ingress, matching the app-worker proxy gate. Enforcement lives at the one place every caller funnels through, so it can no longer be bypassed by a caller that forgets to gate. The platform's shared-data rooms hard-disable the debug API entirely. No change for apps that already gate via the proxy.
- Refresh the AI chat model lineup to the current generation. ChatPanel's default picker and the scaffolded starter's `ALLOWED_MODELS` now offer Claude Sonnet 5 (new default), Claude Opus 4.8, Claude Haiku 4.5, and the GPT-5.6 family (Sol / Terra / Luna) alongside GPT-OSS 120B; the retired-generation entries (Sonnet 4.6, Opus 4.7, the GPT-5.4 picker rows) are dropped from the picker, while their ids stay server-allowlisted. The scaffolded chat route now sends `reasoningEffort: 'none'` for OpenAI models — GPT-5.6 on /v1/chat/completions rejects function tools otherwise ("Function tools with reasoning_effort are not supported"). Apps scaffolded before this release that upgrade `deepspace` must add the new model ids to their `ALLOWED_MODELS` in `src/ai/chat-routes.ts` AND add the same `providerOptions: { openai: { reasoningEffort: 'none' } }` to their `streamText` call for OpenAI models (or pass their own `models` prop to `ChatPanel`) — otherwise the picker's new ids are rejected with a 400 by design, and GPT-5.6 turns with tools error.

## 0.6.1

### Patch Changes

- Make silent failures visible. `RecordProvider` now accepts an `onWriteError` prop (`(error: WriteError) => void`, where `WriteError` is `{ kind: 'permission' | 'validation', title, detail }`) — previously the friendly-error pipeline (server rejection → `parseServerError` → callback) was unreachable from the public API, so a denied or invalid optimistic write looked like a success with no signal anywhere. Unhandled rejections fall back to a loud `console.error` explaining how to wire real UI (note: this fires in production too — existing apps that never wired a handler will start logging rejected writes to the console; each unique error logs once, repeats are suppressed), and the starter template routes `onWriteError` to its toast system out of the box (permission → warning toast, validation → error toast). On localhost, a signed-out `RecordProvider` without `allowAnonymous` renders a visible diagnostic instead of a blank page (production still renders nothing), and passing `schemas` alongside `roomId` (where it's ignored) warns once; both diagnostics can be forced on or off via `globalThis.DEEPSPACE_DEV = true | false` (LAN/tunnel previews, consumer test suites). `deepspace dev` and `deepspace deploy` now run schema lint up front and print findings (e.g. a `visibilityField` no role enforces) in the terminal, capped at 5 with an overflow count — previously these only appeared in the worker console after a client connected.

## 0.6.0

## 0.5.7
