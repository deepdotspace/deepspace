# AGENTS.md

Read <https://docs.deep.space/llms.txt>, then fetch the relevant documentation
page as Markdown by appending `.md`. The installed package types and CLI
`--help` describe the exact version in this project. Use your existing HTTP,
shell, and browser tools; no skill, plugin, connector, or session restart is
required. Installing the optional skill is a separate explicit choice.

## About this project

This is a **DeepSpace** app — a real-time collaborative app built on the
[`deepspace`](https://www.npmjs.com/package/deepspace) SDK and deployed to
Cloudflare Workers via `npx deepspace deploy`. It was scaffolded from the
**copilot template**: a three-panel shell (collapsible sidebar, main panel,
AI chat dock). Keep this layout; consult the design and AI documentation
before changing its providers or chat wiring.

## Project commands

```sh
npx deepspace auth login   # authenticate with app.space
npx deepspace dev start    # local dev server (vite + miniflare)
npx deepspace deploy       # deploy to <app>.app.space
npx deepspace push         # publish committed code to the app's cloud repo
npx deepspace agent tools <app> --json # discover tools and their input schemas
npx deepspace agent invoke <app> <tool> --input-file tool-input.json --json
npx deepspace add --list   # list optional features (messaging, etc.)
npx deepspace add <feature>
```

For local app tools, always run `agent tools` first and follow the returned
description and input schema rather than guessing arguments. `agent invoke`
reuses the current CLI login and requires no separate connection. If it reports
`not_authenticated`, run the refusal's action when present. In a headless shell
without an action, run `npx deepspace auth login --help` and use the
operator-supplied credential path it names; never invent credentials or put a
password on the command line.

Use the DeepSpace cloud repo as the default version control; no external Git
host is required. Start parallel work with
`npx deepspace workspace new -t "<task>"`, commit normally, then run
`npx deepspace workspace sync` and `npx deepspace workspace land`. The `space`
Git remote is installed by the first DeepSpace push/pull/deploy command. With
that default DeepSpace source, deploy requires a clean commit. When the app
ships from GitHub (latched from the checkout's remote at the app's first
release, permanently), deploy instead ships the current checkout, including
dirty or unpushed bytes, and records no commit lineage for that release;
use ordinary Git to decide what should be committed and pushed.
