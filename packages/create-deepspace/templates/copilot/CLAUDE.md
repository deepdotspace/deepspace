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
Cloudflare Workers via `npx deepspace deploy`. It was scaffolded from the
**copilot template**: a three-panel shell (collapsible sidebar, main panel,
AI chat dock) — the shell is the app's layout and stays; see the skill's
`uiux.md` and `ai-chat.md` for its rules.

## Project commands

```sh
npx deepspace auth login   # authenticate with app.space
npx deepspace dev start    # local dev server (vite + miniflare)
npx deepspace deploy       # deploy to <app>.app.space
npx deepspace push         # publish committed code to the app's cloud repo
npx deepspace add --list   # list optional features (messaging, etc.)
npx deepspace add <feature>
```

Use the DeepSpace cloud repo as the default version control; no external Git
host is required. Start parallel work with
`npx deepspace workspace new -t "<task>"`, commit normally, then run
`npx deepspace workspace sync` and `npx deepspace workspace land`. The `space`
Git remote is installed by the first DeepSpace push/pull/deploy command.
