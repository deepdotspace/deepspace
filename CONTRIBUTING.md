# Contributing to DeepSpace

Thanks for your interest in DeepSpace!

## How this repository works

DeepSpace is developed in a private monorepo that also contains the hosted
platform. This public repository is a **release mirror**: on every release,
the SDK packages are synced here as a single squashed commit and tagged. That
means:

- The commit history here is one commit per release, not the full development
  history.
- CI, internal tests, and platform code live in the private repo and are not
  visible here.

## Reporting issues

Please open issues here — this is the canonical public tracker for the
`deepspace` and `create-deepspace` packages. Include the package version
(`npm ls deepspace`), what you expected, and what happened. Minimal
reproductions help a lot.

## Pull requests

PRs are welcome, with one caveat: because this repo is overwritten on each
release, your PR won't be merged here directly. Instead, a maintainer reviews
it, ports it into the internal repo with attribution
(`Co-authored-by: you`), and it ships in the next release — at which point
your change appears here and the PR is closed with a reference to the release.

Keep PRs focused and small; large or speculative changes are better discussed
in an issue first.

## Licensing of contributions

By submitting a pull request, you agree that your contribution is licensed
under the [Apache License 2.0](LICENSE), the same license as the project
(inbound = outbound). For substantial contributions we may ask you to sign a
contributor license agreement before merging.
