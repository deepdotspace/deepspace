/**
 * The unmerged-index refusal, against REAL git states.
 *
 * Every verb that meets a conflicted checkout has to give the SAME answer:
 * "uncommitted changes — commit them" commits the `<<<<<<<` markers. These
 * drive git into each state for real rather than asserting on wording, so
 * deleting the guard cannot leave the suite green.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGit } from '../git/process'
import { hasUnmergedEntries, initRepo, interruptedGitOperation } from '../git/repository'
import { unmergedIndexRefusal } from '../git/safety'

let repo: string

function commit(message: string, content: string, file = 'a.txt') {
  writeFileSync(join(repo, file), content)
  runGit(repo, ['add', '-A'])
  runGit(repo, ['commit', '-q', '-m', message])
}

/** Two branches that changed the same line — merging them conflicts. */
function divergentBranches() {
  commit('base', 'base\n')
  runGit(repo, ['checkout', '-q', '-b', 'other'])
  commit('theirs', 'theirs\n')
  runGit(repo, ['checkout', '-q', 'main'])
  commit('ours', 'ours\n')
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ds-umi-'))
  initRepo(repo, 'main')
  runGit(repo, ['config', 'user.email', 'test@example.com'])
  runGit(repo, ['config', 'user.name', 'Test'])
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe('unmergedIndexRefusal', () => {
  const opts = { ours: 'The merge this land needs', resume: 'deepspace workspace land' }

  it('returns null on a clean tree and on ordinary dirt', () => {
    commit('base', 'base\n')
    expect(unmergedIndexRefusal(repo, opts)).toBeNull()
    // Uncommitted changes are NOT unmerged entries — the caller's own
    // dirty_worktree refusal owns that state, and stealing it here would
    // tell people to resolve conflicts that do not exist.
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    expect(hasUnmergedEntries(repo)).toBe(false)
    expect(unmergedIndexRefusal(repo, opts)).toBeNull()
  })

  it('names OUR merge when a real merge is stopped at conflicts', () => {
    divergentBranches()
    runGit(repo, ['merge', 'other'], { allowFail: true })
    expect(hasUnmergedEntries(repo)).toBe(true)
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).toMatchObject({ code: 'merge_conflict', operation: 'merge' })
    expect(refusal!.message).toContain('The merge this land needs')
    // The whole point: never "commit them", always "resolve the markers".
    expect(refusal!.message).toContain('<<<<<<<')
    expect(refusal!.message).toContain('git add')
  })

  it('tells a cherry-pick to finish itself, not to commit into our merge', () => {
    divergentBranches()
    const theirs = runGit(repo, ['rev-parse', 'other']).stdout.toString('utf-8').trim()
    runGit(repo, ['cherry-pick', theirs], { allowFail: true })
    expect(hasUnmergedEntries(repo)).toBe(true)
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).toMatchObject({ code: 'git_operation_in_progress', operation: 'cherry-pick' })
    expect(refusal!.message).toContain('git cherry-pick --continue')
    expect(refusal!.message).toContain('git cherry-pick --abort')
    expect(refusal!.message).not.toContain('The merge this land needs')
  })

  it('prescribes `git am`, not `git rebase`, for an interrupted patch apply', () => {
    // `git am` and `git rebase --apply` share the rebase-apply directory, and
    // git REFUSES the wrong verb: "It looks like 'git am' is in progress.
    // Cannot rebase." Prescribing rebase here handed back a dead command.
    divergentBranches()
    const patch = join(repo, 'p.patch')
    writeFileSync(
      patch,
      runGit(repo, ['format-patch', '--stdout', 'main..other']).stdout.toString('utf-8'),
    )
    const applied = runGit(repo, ['am', '-3', patch], { allowFail: true })
    expect(applied.status).not.toBe(0)
    expect(hasUnmergedEntries(repo)).toBe(true)
    expect(interruptedGitOperation(repo)).toBe('am')
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).toMatchObject({ code: 'git_operation_in_progress', operation: 'am' })
    expect(refusal!.message).toContain('git am --continue')
    expect(refusal!.message).not.toContain('git rebase')
  })

  it('does not claim a merge is in progress when nothing is', () => {
    // `git merge --squash` conflicts leave unmerged entries with NO operation
    // marker — there is nothing to continue or abort, and the old message
    // asserted "the merge this land needs is already in progress" anyway.
    divergentBranches()
    runGit(repo, ['merge', '--squash', 'other'], { allowFail: true })
    expect(hasUnmergedEntries(repo)).toBe(true)
    expect(interruptedGitOperation(repo)).toBeNull()
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).toMatchObject({ code: 'merge_conflict', operation: null })
    expect(refusal!.message).toContain('unresolved conflicts')
    expect(refusal!.message).not.toContain('already in progress')
    // It still points at the resolution, and at a discard that WORKS:
    // `git checkout -m -- .` was verified to leave the index untouched here,
    // so it looped; `git reset --merge` genuinely clears the state.
    expect(refusal!.message).toContain('<<<<<<<')
    expect(refusal!.message).toContain('git reset --merge')
  })

  it('does not claim a merge is in progress for a conflicted stash pop', () => {
    divergentBranches()
    writeFileSync(join(repo, 'a.txt'), 'stashed\n')
    runGit(repo, ['stash', 'push', '-q'])
    commit('moved on', 'moved\n')
    runGit(repo, ['stash', 'pop'], { allowFail: true })
    expect(hasUnmergedEntries(repo)).toBe(true)
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal!.operation).toBeNull()
    expect(refusal!.message).not.toContain('already in progress')
  })

  it('carries the caller’s own resume command in every state', () => {
    divergentBranches()
    runGit(repo, ['merge', 'other'], { allowFail: true })
    const refusal = unmergedIndexRefusal(repo, {
      ours: 'The merge this sync needs',
      resume: "deepspace workspace sync ws_01ABC",
    })
    expect(refusal!.message).toContain("deepspace workspace sync ws_01ABC")
    expect(refusal!.message).toContain('The merge this sync needs')
  })
})

describe('the guard survives `git add` — the state where "commit them" is most dangerous', () => {
  const opts = { ours: 'The merge this land needs', resume: 'deepspace workspace land' }

  it('still refuses after the conflicted files are staged', () => {
    // `ls-files -u` empties on `git add`, but MERGE_HEAD does not — and
    // `git commit -am` succeeds over a staged-but-unresolved merge in ONE
    // command, committing the markers. Keying on the index alone makes the
    // guard one `git add` deep.
    divergentBranches()
    runGit(repo, ['merge', 'other'], { allowFail: true })
    runGit(repo, ['add', '-A'])
    expect(hasUnmergedEntries(repo)).toBe(false)
    expect(interruptedGitOperation(repo)).toBe('merge')
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).not.toBeNull()
    // The index is CLEAN here, so this is the in-progress state, not the
    // unresolved-conflict one — and the message must not claim otherwise.
    expect(refusal!.code).toBe('git_operation_in_progress')
    expect(refusal!.message).toContain('A merge is in progress')
    expect(refusal!.message).not.toContain('unresolved conflicts')
    // It still says the thing that matters in this exact state: staged is not
    // resolved, so check before continuing.
    expect(refusal!.message).toContain('<<<<<<<')
    expect(refusal!.message).toContain('staging is not resolving')
  })

  it('does not invent conflicts for an operation that never had any', () => {
    // `git rebase -i` stopped at `edit` (here: an `--exec` that fails) leaves
    // a rebase marker with a CLEAN index and nothing staged from a conflict.
    // "with unresolved conflicts" and "the conflicted files are already
    // staged" are both simply false in this state.
    commit('base', 'base\n')
    commit('second', 'second\n')
    runGit(repo, ['rebase', '--exec', 'false', 'HEAD~1'], {
      allowFail: true,
      env: { GIT_SEQUENCE_EDITOR: 'true', GIT_EDITOR: 'true' },
    })
    expect(interruptedGitOperation(repo)).toBe('rebase')
    expect(hasUnmergedEntries(repo)).toBe(false)
    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).toMatchObject({ code: 'git_operation_in_progress', operation: 'rebase' })
    expect(refusal!.message).toContain('A rebase is in progress')
    expect(refusal!.message).toContain('git rebase --continue')
    expect(refusal!.message).toContain('git rebase --abort')
    expect(refusal!.message).toContain('deepspace workspace land')
    // Neither false claim survives: no unresolved conflicts are asserted, and
    // the marker caution is CONDITIONAL rather than stating that conflicted
    // files were staged (nothing was staged here at all).
    expect(refusal!.message).not.toContain('unresolved conflicts')
    expect(refusal!.message).not.toContain('The conflicted files are already staged')
    expect(refusal!.message).toContain('If it stopped at a conflict')
    runGit(repo, ['rebase', '--abort'], { allowFail: true })
  })

  it('offers the abort that ends the state in one command', () => {
    divergentBranches()
    runGit(repo, ['merge', 'other'], { allowFail: true })
    expect(unmergedIndexRefusal(repo, opts)!.message).toContain('git merge --abort')
  })

  it('stays silent for a bisect, which does not own the index', () => {
    commit('base', 'base\n')
    commit('second', 'second\n')
    runGit(repo, ['bisect', 'start'], { allowFail: true })
    runGit(repo, ['bisect', 'bad'], { allowFail: true })
    // No conflict, no unmerged entries — a bisect must not be reported as one.
    expect(unmergedIndexRefusal(repo, opts)).toBeNull()
    runGit(repo, ['bisect', 'reset'], { allowFail: true })
  })
})

describe('a bisect does not swallow someone else’s conflict', () => {
  const opts = { ours: 'The merge this land needs', resume: 'deepspace workspace land' }

  it('still refuses when the index is conflicted during a bisect', () => {
    // A bisect does not own the index. Returning null for the bisect MARKER
    // before checking the index let a real conflict — from a stash pop or a
    // squash merge — fall through to "uncommitted changes, commit them",
    // which commits the `<<<<<<<` markers.
    divergentBranches()
    runGit(repo, ['merge', '--squash', 'other'], { allowFail: true })
    expect(hasUnmergedEntries(repo)).toBe(true)
    runGit(repo, ['bisect', 'start'], { allowFail: true })
    expect(interruptedGitOperation(repo)).toBe('bisect')

    const refusal = unmergedIndexRefusal(repo, opts)
    expect(refusal).not.toBeNull()
    expect(refusal!.code).toBe('merge_conflict')
    expect(refusal!.message).toContain('<<<<<<<')
    // The bisect is not blamed for a conflict it did not create.
    expect(refusal!.operation).toBeNull()
    runGit(repo, ['bisect', 'reset'], { allowFail: true })
  })
})
