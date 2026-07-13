import { describe, it, expect } from 'vitest'
import { computeDoMigration } from '../do-migration'
import type { DOManifestEntry } from '../do-manifest'

const A: DOManifestEntry = { binding: 'ROOM_A', className: 'ClassA', sqlite: true }
const B: DOManifestEntry = { binding: 'ROOM_B', className: 'ClassB', sqlite: true }
const NoSql: DOManifestEntry = { binding: 'KV_LIKE', className: 'KvLike', sqlite: false }

describe('computeDoMigration', () => {
  it('first deploy: all classes are new', () => {
    const r = computeDoMigration([A, B], [])
    expect(r.needsMigration).toBe(true)
    expect(r.newSqliteClasses).toEqual(['ClassA', 'ClassB'])
    expect(r.deletedClasses).toEqual([])
    expect(r.directive?.new_sqlite_classes).toEqual(['ClassA', 'ClassB'])
    expect(r.directive?.deleted_classes).toBeUndefined()
  })

  it('idempotent re-deploy: no migration needed, no directive emitted', () => {
    const r = computeDoMigration(
      [A, B],
      [
        { name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' },
        { name: 'ROOM_B', type: 'durable_object_namespace', class_name: 'ClassB' },
      ],
    )
    expect(r.needsMigration).toBe(false)
    expect(r.directive).toBeNull()
  })

  it('add a class: new tag with new_sqlite_classes only', () => {
    const r = computeDoMigration(
      [A, B],
      [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }],
    )
    expect(r.needsMigration).toBe(true)
    expect(r.newSqliteClasses).toEqual(['ClassB'])
    expect(r.deletedClasses).toEqual([])
    expect(r.directive?.deleted_classes).toBeUndefined()
  })

  it('remove a class: directive includes deleted_classes (the bug we fixed)', () => {
    const r = computeDoMigration(
      [A],
      [
        { name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' },
        { name: 'ROOM_B', type: 'durable_object_namespace', class_name: 'ClassB' },
      ],
    )
    expect(r.needsMigration).toBe(true)
    expect(r.newSqliteClasses).toEqual([])
    expect(r.deletedClasses).toEqual(['ClassB'])
    expect(r.directive?.deleted_classes).toEqual(['ClassB'])
    expect(r.directive?.new_sqlite_classes).toBeUndefined()
  })

  it('add and remove in one deploy: both arrays populated', () => {
    const r = computeDoMigration(
      [B],
      [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }],
    )
    expect(r.needsMigration).toBe(true)
    expect(r.newSqliteClasses).toEqual(['ClassB'])
    expect(r.deletedClasses).toEqual(['ClassA'])
    expect(r.directive?.tag).toMatch(/^m-[0-9a-z]+-[0-9a-f]{8}$/)
  })

  it('non-sqlite classes are not added to new_sqlite_classes (but they still count as bindings)', () => {
    const r = computeDoMigration([NoSql], [])
    // No SQLite migration needed for KV-style classes; CF doesn't need a
    // `new_classes` directive for bindings created in the bindings array.
    expect(r.newSqliteClasses).toEqual([])
    expect(r.needsMigration).toBe(false)
  })

  it('tag is timestamp-anchored: identical inputs at identical `now` produce identical tags (test-only determinism)', () => {
    // Production tags are non-deterministic by design (each new deploy gets
    // a fresh Date.now()); the `now` option exists so tests can assert
    // exact tag values without flake. Same inputs + same `now` → same tag.
    const args = [
      [B],
      [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }],
      { now: 1_000_000 },
    ] as const
    const a = computeDoMigration(...args)
    const b = computeDoMigration(...args)
    expect(a.directive?.tag).toBe(b.directive?.tag)
    expect(a.directive?.tag).toMatch(/^m-[0-9a-z]+-[0-9a-f]{8}$/)
  })

  it('tag changes when only `now` advances — same delta, different deploy moments', () => {
    const args = (now: number) =>
      [[B], [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }], { now }] as const
    const t1 = computeDoMigration(...args(1_000_000)).directive?.tag
    const t2 = computeDoMigration(...args(1_000_001)).directive?.tag
    expect(t1).not.toBe(t2)
  })

  it('tag distinguishes add-only from remove-only (no false collisions)', () => {
    // [A] → [A,B]: add B
    const addB = computeDoMigration(
      [A, B],
      [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }],
    )
    // [A,B] → [A]: remove B
    const rmB = computeDoMigration(
      [A],
      [
        { name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' },
        { name: 'ROOM_B', type: 'durable_object_namespace', class_name: 'ClassB' },
      ],
    )
    expect(addB.directive?.tag).not.toBe(rmB.directive?.tag)
  })

  it('survives going [A] → [A,B] → [A]: each step gets a unique tag (no orphan)', () => {
    const t1 = computeDoMigration([A], []).directive?.tag
    const t2 = computeDoMigration(
      [A, B],
      [{ name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' }],
    ).directive?.tag
    const t3 = computeDoMigration(
      [A],
      [
        { name: 'ROOM_A', type: 'durable_object_namespace', class_name: 'ClassA' },
        { name: 'ROOM_B', type: 'durable_object_namespace', class_name: 'ClassB' },
      ],
    ).directive?.tag
    expect(new Set([t1, t2, t3]).size).toBe(3)
  })

  it('cycle [A] → [A,B] → [A] → [A,B] → [A] produces 5 distinct tags (regression: pure content-addressing collided)', () => {
    // The Opus reviewer flagged this gap. Pre-fix, the tag was hash(add, remove);
    // the 4th deploy (re-adding B) had identical content to the 2nd, CF
    // rejected the deploy with "tag already applied". Even adding `prev`
    // (existing state) to the hash didn't help — cycles return to identical
    // prior states. Real fix: include a monotonic timestamp in the tag.
    let existing: Array<{ name: string; type: string; class_name: string }> = []
    const tags: string[] = []
    let now = 1_000_000

    const apply = (manifest: typeof A[]) => {
      // Distinct millisecond per deploy — matches real-world `Date.now()`
      // behavior where two deploys to the same script can't collide on ms.
      now += 1
      const r = computeDoMigration(manifest, existing, { now })
      if (r.directive) tags.push(r.directive.tag)
      // Simulate CF state after this deploy: existing ← new manifest's bindings.
      existing = manifest.map((e) => ({
        name: e.binding,
        type: 'durable_object_namespace',
        class_name: e.className,
      }))
    }

    apply([A])         // step 1: + ClassA
    apply([A, B])      // step 2: + ClassB
    apply([A])         // step 3: − ClassB
    apply([A, B])      // step 4: + ClassB AGAIN (was the duplicate-tag case)
    apply([A])         // step 5: − ClassB AGAIN

    expect(tags).toHaveLength(5)
    expect(new Set(tags).size, `tags must all be unique; got ${tags.join(', ')}`).toBe(5)
  })

  it('falls back to binding name when CF response omits class_name', () => {
    // Older CF API responses may omit class_name; we use the binding name as
    // the deletion key in that case.
    const r = computeDoMigration([], [{ name: 'ORPHAN', type: 'durable_object_namespace' }])
    expect(r.deletedClasses).toEqual(['ORPHAN'])
  })

  it('ignores non-DO bindings when computing the existing set', () => {
    const r = computeDoMigration(
      [A],
      [
        { name: 'KV_THING', type: 'kv_namespace' },
        { name: 'STALE', type: 'durable_object_namespace', class_name: 'StaleClass' },
      ],
    )
    expect(r.deletedClasses).toEqual(['StaleClass'])
  })
})
