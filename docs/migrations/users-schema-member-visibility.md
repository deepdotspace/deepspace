# Users-schema member visibility

Use this retrofit only when `deepspace app update` reports that an existing
app-owned `src/schemas/users-schema.ts` grants `member` the collection rule
`read: true`. Fresh scaffolds use `read: 'own'`; the updater deliberately does
not rewrite an app's permission policy.

The member `read` rule governs full-row reads, not the roster: it decides
what an ordinary `useQuery('users')` subscription receives — with
`read: true` that is every full users row, including email and any
app-defined profile column. `useUsers()`, by contrast, returns the
public-identity projection (`id`, `name`, optional image, `role`) of every
registered user to every signed-in caller regardless of the row rule, so
collaborators can always name each other. Two roster opt-outs exist on the
users schema: a role whose `read` is `false` (or absent) gets an empty
roster, and `roster: 'read-policy'` scopes the roster to the rows the
caller's read policy grants (still projected to public identity) — for apps
that partition users by tenant/team and must not show names across the
partition.

For the safer default, change only the member read rule:

```ts
member: { read: 'own', create: false, update: 'own', delete: false },
```

Keep `read: true` only if the app intentionally treats every full users row and
every future app-defined users column as member-visible. The SDK does not apply
the `useUsers()` public-field projection to ordinary `useQuery('users')`
subscriptions. After either decision, test with two regular users and verify
that `useQuery('users')` matches the chosen row policy; with the default
roster, `useUsers()` returns both users' public identity either way.
