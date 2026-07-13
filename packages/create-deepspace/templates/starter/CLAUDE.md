# CLAUDE.md

**Load the `deepspace` skill before working in this repo.** It is the source
of truth for the SDK — invoke it via the Skill tool first, then read project
source for repo-specific details.

The skill is installed by the scaffold at `.agents/skills/deepspace/SKILL.md`
(for Claude Code agents, a `.claude/skills/deepspace` symlink is also
created so Claude Code picks it up).
Restart your agent session so it picks up the new skill — or, to keep
working without a restart, Read `.agents/skills/deepspace/SKILL.md` directly
(loading `references/*` on demand).

If the file doesn't exist, scaffold-time install failed (typically a network
issue). Install (or reinstall) it manually:

```sh
npx -y skills@latest add deepdotspace/deepspace-skill -y                 # this project
npx -y skills@latest add deepdotspace/deepspace-skill -g -y              # globally, every project
npx -y skills@latest add deepdotspace/deepspace-skill --agent codex -y   # specific agent
```

If you can't install it at all, read SKILL.md directly:
<https://github.com/deepdotspace/deepspace-skill/blob/main/skills/deepspace/SKILL.md>

## About this project

This is a **DeepSpace** app — a real-time collaborative app built on the
[`deepspace`](https://www.npmjs.com/package/deepspace) SDK and deployed to
Cloudflare Workers via `npx deepspace deploy`.

## Static vs dynamic pages

A page's location under `src/pages/` decides whether it pays for auth and
realtime — the DeepSpace providers are mounted in `src/pages/(app)/_layout.tsx`,
not at the root, so only pages under `(app)/` connect.

| Put a page here | It gets | Use for |
|---|---|---|
| `src/pages/*.tsx` (top level) | **Static** — no `/api/auth` fetch, no `/ws` socket. No `useAuth`/`useQuery`/`useMutations`. | Landing, marketing, docs, legal, anything logged-out or crawler traffic hits. |
| `src/pages/(app)/*.tsx` | **Dynamic** — auth + realtime providers. `useAuth`/`useQuery`/`useMutations` work. | Signed-out-visible app pages that read/write live data. |
| `src/pages/(app)/(protected)/*.tsx` | Dynamic **and** sign-in required (`<AuthGate>`). | Pages that must not render without a session. |

`(app)` and `(protected)` are Generouted route groups — the parentheses mean
they don't appear in the URL, so `(app)/home.tsx` is served at `/home`. To flip
a page between static and dynamic, move the file across the boundary (fix up its
`../` relative imports for the new depth). The shipped `src/pages/index.tsx` is
a static landing; `(app)/home.tsx` is the dynamic example.

`npx deepspace add <feature>` installs feature pages under `(app)/` (or
`(app)/(protected)/` for protected ones) automatically, so features always get
their providers.

## Project commands

```sh
npx deepspace login        # authenticate with app.space
npx deepspace dev          # local dev server (vite + miniflare)
npx deepspace deploy       # deploy to <app>.app.space
npx deepspace add --list   # list optional features (messaging, etc.)
npx deepspace add <feature>
```

