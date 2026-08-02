# CLAUDE.md

**Load the `deepspace` skill before working in this repo.** It is the source
of truth for the SDK — invoke it via the Skill tool first, then read project
source for repo-specific details.

The scaffold installs the skill at `.agents/skills/deepspace/SKILL.md` (with
a `.claude/skills/deepspace` symlink so Claude Code picks it up). Restart
your agent session to load it — or Read that SKILL.md directly. If the file
is missing, scaffold-time install failed (typically a network issue);
reinstall:

```sh
npx -y skills@latest add deepdotspace/deepspace-skill -y                 # this project
npx -y skills@latest add deepdotspace/deepspace-skill -g -y              # globally, every project
npx -y skills@latest add deepdotspace/deepspace-skill --agent codex -y   # specific agent
```

If you can't install it at all, read
<https://github.com/deepdotspace/deepspace-skill/blob/main/skills/deepspace/SKILL.md>.

## About this project

This is a **DeepSpace** app — a real-time collaborative app built on the
[`deepspace`](https://www.npmjs.com/package/deepspace) SDK and deployed to
Cloudflare Workers via `npx deepspace deploy`.

## Version control

The app's **cloud repo** on the DeepSpace platform is the default version
control; no external account is needed. The first DeepSpace push/pull/deploy
command installs its Git remote as `space`. **Don't set up GitHub (or another
git host) unless the developer explicitly asks.** Commit before you deploy
(`deploy` records the commit it ships and refuses a dirty worktree). For
parallel work: `workspace new -t "<task>"` → commit → `workspace sync` →
`workspace land`. Use `status`, `activity`, `releases`, and `rollback` to
recover context and inspect what is live.

## Project commands

```sh
npx deepspace auth login        # authenticate with app.space
npx deepspace dev start    # local dev server (vite + miniflare)
npx deepspace deploy       # deploy to <app>.app.space
npx deepspace push         # sync code to the app's cloud repo (default VCS — see "Version control")
npx deepspace add --list   # list optional features (messaging, etc.)
npx deepspace add <feature>
```
