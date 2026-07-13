# DeepSpace

> ⚠️ **Alpha** — DeepSpace is under active development. APIs may change
> between 0.x minor versions; check the changelogs before upgrading.

Build real-time collaborative apps on Cloudflare Workers. DeepSpace bundles
auth, real-time data subscriptions, RBAC, messaging, file storage,
collaborative editing (Yjs), and zero-config deployment to `.app.space`
behind two imports.

```bash
npm create deepspace my-app
cd my-app
npm run dev
```

## Packages

| Package | Description |
| --- | --- |
| [`deepspace`](packages/deepspace) ([npm](https://www.npmjs.com/package/deepspace)) | The SDK — React client, Cloudflare Worker runtime, and CLI |
| [`create-deepspace`](packages/create-deepspace) ([npm](https://www.npmjs.com/package/create-deepspace)) | Project scaffolder (`npm create deepspace`) |

Both packages version together; see each package's `CHANGELOG.md` for release
notes.

## About this repository

This is the public source for the DeepSpace SDK packages. Development happens
in a private monorepo that also contains the DeepSpace platform; this
repository is synced on every release, one commit per version.

- **Issues** — welcome here; this is the right place to report bugs and
  request features.
- **Pull requests** — see [CONTRIBUTING.md](CONTRIBUTING.md); accepted changes
  are ported into the internal repo by maintainers with attribution.

## License

[Apache-2.0](LICENSE)
