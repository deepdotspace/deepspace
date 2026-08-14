# create-deepspace

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
