# AGENTS.md

**Load the `deepspace` skill before working in this repo.** It is the source
of truth for the SDK; read project source afterward for repo-specific details.

The scaffold installs the portable skill at
`.agents/skills/deepspace/SKILL.md`. Restart the agent session to load newly
installed skills, or read that file directly. If it is missing, scaffold-time
installation failed (typically a network issue); reinstall:

```sh
npx -y skills@latest add deepdotspace/deepspace-skill -y                 # this project
npx -y skills@latest add deepdotspace/deepspace-skill -g -y              # globally, every project
npx -y skills@latest add deepdotspace/deepspace-skill --agent codex -y   # specific agent
```

If installation is unavailable, read
<https://github.com/deepdotspace/deepspace-skill/blob/main/skills/deepspace/SKILL.md>.

## About this project

This is a **DeepSpace** app — a real-time collaborative app built on the
[`deepspace`](https://www.npmjs.com/package/deepspace) SDK and deployed to
Cloudflare Workers via `npx deepspace deploy`.

## Version control

The app's **cloud repo** on the DeepSpace platform is the default version
control; no external account is needed. The first DeepSpace push/pull/deploy
command installs its Git remote as `space`. **Don't set up GitHub (or another
git host) unless the developer explicitly asks.** With the default DeepSpace
source, commit before you deploy: the release records that commit and refuses
a dirty worktree. After an explicit GitHub source claim, deploy instead ships
the current checkout, including dirty or unpushed bytes, and records no commit
lineage for that release; use ordinary Git to decide what should be committed
and pushed. For parallel DeepSpace-source work: `workspace new -t "<task>"` →
commit → `workspace sync` → `workspace land`. Use `status`, `activity`,
`releases`, and `rollback` to recover context and inspect what is live.

## Project commands

```sh
npx deepspace auth login   # authenticate with app.space
npx deepspace dev start    # local dev server (vite + miniflare)
npx deepspace deploy       # deploy to <app>.app.space
npx deepspace push         # sync code to the app's cloud repo
npx deepspace add --list   # list optional features (messaging, etc.)
npx deepspace add <feature>
```
