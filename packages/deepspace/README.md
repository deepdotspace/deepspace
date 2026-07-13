# deepspace

> ⚠️ **Alpha** — DeepSpace is under active development. APIs may change
> between 0.x minor versions; check the [changelog](./CHANGELOG.md) before
> upgrading.

The DeepSpace SDK — build real-time collaborative apps on Cloudflare Workers.
Bundles auth, real-time data subscriptions, RBAC, messaging, file storage,
collaborative editing (Yjs), and zero-config deployment behind two imports.

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

The package has two entry points:

- **`deepspace`** — the React client SDK (hooks, providers, auth, storage,
  messaging, theme). Runs in the browser.
- **`deepspace/worker`** — the Cloudflare Worker runtime (`RecordRoom`, schemas,
  JWT verification, HMAC auth). Runs in your app's Worker.

## Minimal usage

Client — wrap your app and subscribe to a collection:

```tsx
import { RecordProvider, useQuery } from 'deepspace'

function App() {
  return (
    <RecordProvider roomId="my-app">
      <Tasks />
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

Worker — expose a `RecordRoom` Durable Object:

```ts
import { RecordRoom } from 'deepspace/worker'

export class MyRoom extends RecordRoom {}
```

## CLI

The package ships a `deepspace` binary for local dev and deployment:

```bash
npx deepspace login      # authenticate
npx deepspace dev        # run locally
npx deepspace deploy     # deploy to *.app.space
```

## Debugging

Client SDK connection/auth/Yjs logs are silent by default. Enable them with
`localStorage.DEEPSPACE_DEBUG = '1'` in the browser. Set the `DEEPSPACE_DO_PERF`
env binding on your Worker to emit per-connection `[DO Perf]` timing logs.

## License

MIT
