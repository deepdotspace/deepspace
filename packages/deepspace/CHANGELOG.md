# deepspace

## 0.6.1

### Patch Changes

- Make silent failures visible. `RecordProvider` now accepts an `onWriteError` prop (`(error: WriteError) => void`, where `WriteError` is `{ kind: 'permission' | 'validation', title, detail }`) — previously the friendly-error pipeline (server rejection → `parseServerError` → callback) was unreachable from the public API, so a denied or invalid optimistic write looked like a success with no signal anywhere. Unhandled rejections fall back to a loud `console.error` explaining how to wire real UI (note: this fires in production too — existing apps that never wired a handler will start logging rejected writes to the console; each unique error logs once, repeats are suppressed), and the starter template routes `onWriteError` to its toast system out of the box (permission → warning toast, validation → error toast). On localhost, a signed-out `RecordProvider` without `allowAnonymous` renders a visible diagnostic instead of a blank page (production still renders nothing), and passing `schemas` alongside `roomId` (where it's ignored) warns once; both diagnostics can be forced on or off via `globalThis.DEEPSPACE_DEV = true | false` (LAN/tunnel previews, consumer test suites). `deepspace dev` and `deepspace deploy` now run schema lint up front and print findings (e.g. a `visibilityField` no role enforces) in the terminal, capped at 5 with an overflow count — previously these only appeared in the worker console after a client connected.

## 0.6.0

### Minor Changes

- `deepspace collaborators add <email>` can now invite someone who isn't a DeepSpace user yet: it sends them an email invitation (billed to the app owner) and they become a collaborator when they sign in and accept it. The new `deepspace collaborators cancel <email>` rescinds a pending invite, and `collaborators list` now shows outstanding invites alongside active collaborators.

### Patch Changes

- `deepspace deploy` on a repo without `DEEPSPACE_APP_ID` no longer silently mints a fresh id destined for a route-claim collision when the name belongs to an existing app. Adoption now also recognizes legacy name-as-id apps the caller deploys on-behalf (collaborator or admin): adopting an app you own stays automatic; adopting one you _don't_ own asks for confirmation (or `--adopt` for non-interactive runs); a name owned by an app you can't deploy fails up front with the real reason.

## 0.5.7

### Patch Changes

- 7301e30: Relicense to Apache-2.0 (from the next release onward), add LICENSE files, repository/homepage/bugs metadata, alpha notices, and a README for create-deepspace. Source is now published to the public mirror repo at https://github.com/deepdotspace/deepspace on every release.
