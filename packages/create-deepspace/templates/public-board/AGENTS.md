# Public board

The app lives at `/` under `src/pages/(app)/`. There is no marketing landing page.
Read https://docs.deep.space/llms.txt and relevant Markdown pages for SDK
guidance. Use native HTTP, shell, and browser tools; no skill or plugin is required.

Anonymous visitors use the `viewer` role. Exact role rules take precedence over `*`.
This template deliberately allows anyone with the URL to read, add, and complete ideas.
It is for public content. Robots exclusion is not access control or spam protection.
Use authenticated, scoped permissions for private data. Anonymous visitors cannot delete
or change existing idea text. `maxLength: 280` is enforced by the server for all writes.
Keep the required users schema and confirmed mutations. Adapt the appearance to the task.

Deploy the app directly, open its public URL in your existing browser, write an
item, reload, and verify it survives. Use two browser sessions to check live
synchronization. Local development and browser test suites are optional; they
are not an onboarding or deployment requirement. Commit app source before
deploying.

## Version control

The app's **cloud repo** on the DeepSpace platform is the default version
control; no external account is needed. The first DeepSpace push/pull/deploy
command installs its Git remote as `space`. **Don't set up GitHub (or another
git host) unless the developer explicitly asks.** With the default DeepSpace
source, commit before you deploy: the release records that commit and refuses
a dirty worktree. When the app ships from GitHub (latched from the checkout's
remote at the app's first release, permanently), deploy instead ships the
current checkout, including dirty or unpushed bytes, and records no commit
lineage for that release; use ordinary Git to decide what should be committed
and pushed. For parallel DeepSpace-source work: `workspace new -t "<task>"` →
commit → `workspace sync` → `workspace land`. Use `status`, `activity`,
`releases`, and `rollback` to recover context and inspect what is live.

## Account and commands

```sh
npm run login              # authenticate (prototype scaffolds: npm run login -- --name <name>)
npx deepspace app init --json
npx deepspace deploy --json
npx deepspace dev start    # optional local dev server
```

The hosting account is separate from whether app visitors sign in. The
public-board tests use anonymous browser contexts. An independent agent on the
staging prototype instead follows
https://deepdotspace-site-staging.spacestest.com/docs/agents/start.md.
