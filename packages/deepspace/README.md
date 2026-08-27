# deepspace

> ⚠️ **Alpha** — DeepSpace is under active development. APIs may change
> between 0.x minor versions; check the [changelog](./CHANGELOG.md) before
> upgrading.

The DeepSpace SDK — build real-time collaborative apps on Cloudflare Workers.
Bundles auth, real-time data subscriptions, RBAC, messaging, file storage,
collaborative editing (Yjs), and zero-config deployment through focused public
entry points.

The fastest way to start is to scaffold a full app rather than wire the SDK up
by hand:

```bash
npm create deepspace my-app
cd my-app
npm run dev
```

## Install

```bash
npm install deepspace
```

`react` / `react-dom` are peer dependencies for the client entry point.

## Entry points

The package has seven supported import paths:

- **`deepspace`** — the React client SDK (hooks, providers, auth, storage,
  messaging, theme). Runs in the browser.
- **`deepspace/schema`** — schema builders and shared schema types.
- **`deepspace/worker`** — the Cloudflare Worker runtime (`RecordRoom`, schemas,
  JWT verification, HMAC auth). Runs in your app's Worker.
- **`deepspace/server`** — app-server helpers for actions, billing, and room
  handlers.
- **`deepspace/testing`** — Playwright fixtures for multi-user tests.
- **`deepspace/documentation`** — documentation compiler and runtime helpers.
- **`deepspace/documentation/react`** — documentation React components.

## Minimal usage

Client — wrap your app and subscribe to a collection:

```tsx
import { RecordProvider, RecordScope, useQuery } from 'deepspace'
import { schemas } from './schemas'

function App() {
  return (
    <RecordProvider allowAnonymous>
      <RecordScope roomId="app:my-app" schemas={schemas}>
        <Tasks />
      </RecordScope>
    </RecordProvider>
  )
}

function Tasks() {
  const { records, status } = useQuery('tasks', {
    orderBy: 'createdAt',
    orderDir: 'desc',
  })
  if (status === 'loading') return null
  return (
    <ul>
      {records.map((r) => (
        <li key={r.recordId}>{r.data.title}</li>
      ))}
    </ul>
  )
}
```

`useMutations(collection)` exposes the existing RecordRoom `ready` state.
Writes attempted before it is true reject with `RecordRoomNotReadyError`
(`code: "not_ready"`) instead of disappearing into a closed socket. For direct
Yjs rooms, `connected` describes the current WebSocket and `synced` describes
completion of the current connection's initial document sync.

Worker — expose a `RecordRoom` Durable Object:

```ts
import { RecordRoom } from 'deepspace/worker'

export class MyRoom extends RecordRoom {}
```

## CLI

The package ships a `deepspace` binary for local dev and deployment:

```bash
npx deepspace auth login # authenticate
npx deepspace dev start  # run locally
npx deepspace deploy     # deploy to *.app.space
```

When updating an existing app, run the target CLI rather than the app's old
installed binary:

```bash
npx deepspace@latest app update
```

The target CLI is the sole version authority. The command is read-only: it
reports dependency edits, app-owned source migrations, and validation steps,
but never rewrites or stamps the checkout. Apply the guidance, run the app's
checks, review the diff, and commit it before deploying. The inspection exits
successfully even when work remains; `ready` in `--json` reports whether the
app is already aligned.

The hierarchy shown by `deepspace --help` keeps durable app lifecycle under
`deepspace app`, while checkout-oriented Git, workspace, release, and deploy
operations stay top-level. The historical `deepspace app migrate` command was
removed in 0.15.0; it is not an upgrade or recovery path.

Every app has one authoritative Git repository, and which one it is follows
from what you do rather than from anything you declare. DeepSpace source is the
packaged default: on a checkout with no GitHub remote, the first
`deepspace push` — or the source sync inside the first normal deploy — claims
it and publishes automatically. `deepspace push` publishes the current branch
and `deepspace clone <app>` checks it out; both configure a `space` remote and
credential helper, so normal `git fetch space` and `git push space` work
afterward.

GitHub source is explicit and manual because the developer owns that repository:

```bash
git remote add origin git@github.com:owner/repository.git
git push -u origin main
npx deepspace deploy
```

Nothing to declare: a checkout with a GitHub remote deploys as GitHub
automatically — DeepSpace never reads or writes the GitHub repository, and
each release records which repository the checkout pointed at (and whether
the tree was dirty). The first `deepspace push` instead claims DeepSpace
source, permanently — using it is choosing it; there are no transfers.
Inspect with `deepspace app source` (read-only). Commands support `--json`
for agents. Use `deepspace --help`, command-specific `--help`, and the
[public manual](https://docs.deep.space) for workspaces, releases, and
rollback.

In a container, give Git its own credentials before a private-repository
verification. Forward an SSH agent, or configure an ephemeral Git credential
helper in the container. Never embed a token in the remote URL: URLs can appear
in process listings, logs, and copied configuration.

Use the current command-specific release notes for supported upgrade steps. If
an app or checkout still carries a name-shaped legacy id, stop and contact the
DeepSpace operator; do not downgrade the SDK or run migration commands copied
from historical changelogs and proposals.

## Debugging

Client SDK connection/auth/Yjs logs are silent by default. Enable them with
`localStorage.DEEPSPACE_DEBUG = '1'` in the browser. Set the `DEEPSPACE_DO_PERF`
env binding on your Worker to emit per-connection `[DO Perf]` timing logs.

## License

Apache-2.0
