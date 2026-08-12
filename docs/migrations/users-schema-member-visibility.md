# Users-schema member visibility

Use this retrofit only when `deepspace app update` reports that an existing
app-owned `src/schemas/users-schema.ts` grants `member` the collection rule
`read: true`. Fresh scaffolds use `read: 'own'`; the updater deliberately does
not rewrite an app's permission policy.

`useUsers()` applies the same row policy before projecting public identity
fields. With `read: 'own'`, a member therefore sees only their own projected
directory entry. The safer collection rule also prevents an ordinary
`useQuery('users')` subscription from receiving every full users row, including
app-defined profile columns.

For the safer default, change only the member read rule:

```ts
member: { read: 'own', create: false, update: 'own', delete: false },
```

Keep `read: true` only if the app intentionally treats every full users row and
every future app-defined users column as member-visible. The SDK does not apply
the `useUsers()` public-field projection to ordinary `useQuery('users')`
subscriptions. After either decision, test with two regular users and verify
that both `useQuery('users')` and `useUsers()` match the chosen row policy.
