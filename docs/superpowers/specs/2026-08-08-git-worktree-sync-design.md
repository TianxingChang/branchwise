# branchwise — git worktree ⇄ canvas sync

Design, 2026-08-08.

Replaces the invented node tree from the first frontend pass with a canvas that
is a live view of the repository's worktrees, and lets the canvas create and
remove them.

---

## Verified premises

These were checked against real git before designing, not taken from memory.

1. `git worktree list --porcelain` returns a **flat** list — `worktree <path>`,
   `HEAD <sha>`, `branch <ref>` per entry. There is no hierarchy in it.
2. **Git stores no parent-branch relationship.** After creating `feat/a` and
   `feat/b`, `git config --get-regexp '^branch\.'` is empty.
3. Git *does* record branch origin in the reflog. The first entry of
   `.git/logs/refs/heads/<name>` is `branch: Created from <ref>`:
   - `git worktree add -b feat/c <path> feat/a` → `Created from feat/a` — the
     parent by name.
   - `git worktree add -b feat/a <path>` (no start point) → `Created from HEAD`
     — only a sha, needs a second inference step.
4. `git branch --contains <sha>` is ambiguous by design: for a fresh branch it
   returns the parent *and* the branch itself, and more when tips coincide. The
   reflog string is strictly better evidence.
5. A linked worktree's `.git` is a **file** containing
   `gitdir: <repo>/.git/worktrees/<id>`. The main repo's `.git/worktrees/<id>/`
   directory is the watchable artefact.
6. oRPC (installed version) exports `eventIterator` / `EventPublisher`, and the
   client codec handles `AsyncIteratorObject` — so server→client streaming can
   go over the existing MessagePort link rather than a second IPC channel.
   **To be proven with a spike before building on it.**

---

## Authority model

| Layer | Authority | Stored in |
| --- | --- | --- |
| Existence — which nodes exist | git, absolutely | `git worktree list --porcelain` |
| Structure — which node hangs off which | branchwise | `.branchwise/graph.json` |
| Presentation — selection, panel | branchwise | `.branchwise/graph.json` |

The consequence that drives everything else: **`graph.json` no longer holds a
node list.** It degrades to an annotation table keyed by branch name. The two
sides can never disagree, because they no longer describe the same thing.

### Decisions

- **A node is a worktree**, not a branch. A branch with no worktree is not on
  the canvas. The set is naturally bounded, and an agent needs a worktree to
  work in at all.
- **An edge is provenance** — "created from", a historical fact. A rebase does
  not move nodes. Edges change only when the user moves them.
- **branchwise-created worktrees live in `<repo>.worktrees/<slug>`** — a sibling
  directory, so build tools, editors and watchers never recurse into them.
  Worktrees created elsewhere by an agent are read and displayed wherever they
  are; the convention only governs where *we* create them.
- **A git repository is required.** A non-repo folder offers `git init`.
- **Deleting a node** opens a confirmation listing worktree path, uncommitted
  file count, merge status against the parent, and child count. Merged → the
  "also delete the branch" box is pre-ticked; unmerged → unticked, with the
  reason shown. Children are **re-parented to the grandparent**, never cascaded.
- **External changes always re-frame the view but never steal the selection**
  or the panel's contents. A "nothing selected" state exists; clicking empty
  canvas deselects and collapses the panel.

### graph.json v2

```jsonc
{
  "version": 2,
  "branches": {
    "feat/agent-panel": { "parent": "main", "parentSource": "reflog" },
    "feat/diff-view":   { "parent": "feat/agent-panel", "parentSource": "user" }
  },
  "panel": { "collapsed": false, "tab": "agent", "width": 420 },
  "selectedWorktree": "/Users/…/branchwise.worktrees/feat-agent-panel"
}
```

`parentSource` is `created` (we made it), `reflog` (inferred), or `user`
(manually corrected). Inferred edges render dashed-lighter; `user` edges are
never re-inferred.

v1 documents are discarded on read — their node list described branches that
never existed in git.

---

## Parent resolution

Runs once per newly discovered branch; the result is **written straight back to
`graph.json`**, because reflogs expire (90 days by default) and cannot serve as
storage.

1. Annotation exists → use it. User corrections win over everything.
2. `git reflog show --format=%gs <branch> | tail -1`:
   - `branch: Created from <ref>` and `<ref>` resolves to a known branch →
     that is the parent.
   - `branch: Created from HEAD` → take the sha from the reflog entry, run
     `git branch --contains <sha>`, drop self; exactly one candidate wins,
     otherwise prefer the main worktree's current branch.
3. Nothing usable → attach to root.

**If the parent branch has no worktree** it is not a node. Walk up the
provenance chain until reaching a branch that *is* a node; if the walk runs out,
attach to root. This keeps the tree connected — there are never orphan nodes.
The walk is cycle-guarded.

The root node is the **main worktree**, labelled with its checked-out branch (or
`detached @ abc1234`). It is never removable.

---

## Main process

### `GitRepo` — command wrapper, one per project

`resolveRepo` · `listWorktrees` · `branchOrigin` · `createWorktree` ·
`removeWorktree` · `deleteBranch` · `isMergedInto` · `workingTreeStatus`

`resolveRepo` normalises through `git rev-parse --git-common-dir` so that
opening a *linked* worktree still resolves to the main repository.

Every command runs through a **per-repo serial queue**. The user and an agent
mutating refs concurrently will otherwise collide on `index.lock`.

### `WorktreeWatcher`

Watches, under the common git dir:

```
worktrees/        worktree added / removed
refs/heads/       (recursive) branch created / deleted / moved
packed-refs       loose refs vanish here after gc
HEAD              main worktree switched branch
```

**fs events are a signal that something happened, never a description of what.**
On any event: debounce 150 ms → re-run `git worktree list` → diff against the
previous snapshot → emit only if it actually differs. Our own writes therefore
produce no spurious updates; the pipeline is idempotent.

**Deliberately not watched:** per-worktree dirty state. It needs `git status` in
every worktree and costs grow linearly with node count. Dirty and ahead/behind
counts are computed **on demand** — for the selected node's panel and for the
delete dialog only.

### Transport

`repo.watch(path)` is an ordinary oRPC procedure returning an event iterator;
the renderer consumes it with `for await` in an effect. Types stay end-to-end
inferred and no second IPC channel is introduced.

---

## Renderer

`graph-store` becomes `repo-store`:

```ts
projects[path] = {
  repo: RepoInfo | null,        // null → not a git repository
  snapshot: WorktreeSnapshot,   // from git, authoritative
  annotations: Record<string, BranchAnnotation>,
  selectedWorktree: string | null,
  panel: PanelState,
}
```

Canvas nodes are **derived** from `snapshot` joined with `annotations` — the
same "positions are derived" discipline as the existing dagre layout, one level
up.

---

## Edge cases

| Case | Handling |
| --- | --- |
| Empty repo (`git init`, no commits) | HEAD unborn, branches cannot be created — prompt for a first commit |
| Detached-HEAD worktree | Label `detached @ abc1234`, no parent edge, attaches to root |
| Worktree directory deleted by hand | git still lists it as `prunable` → shown as "missing", with a one-click `git worktree prune` |
| Branch name contains `/` | Path slug flattens it (`feat/a` → `feat-a`) rather than nesting directories |
| Branch renamed with `git branch -m` | Annotation migrated via the worktree path, which is stable across the rename |
| Main worktree switches branch | Root node relabels |
| Bare repo, or a linked worktree opened directly | Normalised to the main repo, or refused with a clear message |
| Target worktree path already exists | Refuse and ask for a different name |
| Parent worktree has uncommitted changes | Non-blocking notice: the child starts from the parent's last commit |

---

## Testing

**Pure units:** `parseWorktreeList`, `parseBranchOrigin`, `resolveParents`
(including the walk-up-to-nearest-node rule and cycle guard), `diffSnapshots`,
`slugForBranch`.

**Real-git integration tests** carry the weight here: create a temporary
repository in the test, actually run `git worktree add`, and assert the tree we
derive. The probes that produced the premises above found `Created from HEAD` —
a case no amount of reading documentation would have surfaced.

---

## Staging

| Stage | Scope | Standalone value |
| --- | --- | --- |
| 1 | Read-only sync: repo resolution, worktree listing, watcher, parent inference, rendering. No writes to git. | Proves the hard half — live updates and inference. An agent's new worktree appears immediately. |
| 2 | Canvas → git: create child worktree, merge-aware delete. | Closes the loop. |
| 3 | Ahead/behind and dirty badges, drag-to-re-parent, rename. | Polish. |
