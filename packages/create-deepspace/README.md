# create-deepspace

> ⚠️ **Alpha** — DeepSpace is under active development. APIs may change
> between 0.x minor versions; check the [changelog](./CHANGELOG.md) before
> upgrading.

Scaffold a new [DeepSpace](https://deep.space) app — real-time collaborative
apps on Cloudflare Workers with auth, live data sync, RBAC, messaging, file
storage, collaborative editing, and one-command deploy built in.

Requires Node 22.15+, 24, or 26 and, when using npm, **npm 11.6+**.
Older npm versions have a peer-dependency resolver bug triggered by the
template's test tooling. The scaffolder checks npm before creating files.
Run `npm install --global npm@11` to update an older npm, then retry.
pnpm, yarn, and bun use their own installers.
Generated apps configure Yarn 2+ to use `node_modules`, which the build tools
and DeepSpace CLI require.

```bash
npm create deepspace my-app
cd my-app
npm run dev
```

Deploy to `<your-app>.app.space`:

```bash
npm run deploy
```

See the [`deepspace` package](https://www.npmjs.com/package/deepspace) for the
SDK itself.

## License

Apache-2.0
