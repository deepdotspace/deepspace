# deepspace

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

- **`deepspace app migrate` is removed**, replaced by `deepspace app update` (below). It existed for one historical cutover — moving an app from a name-shaped id to a canonical one — and the platform endpoints behind it are unchanged, so an app still on a legacy id migrates with `npx deepspace@0.13.0 app migrate` and then upgrades normally.

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
