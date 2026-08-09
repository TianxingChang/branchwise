# branchwise

A desktop workspace for coding across many git branches at once.

Each tab is a git repository. Inside it, the canvas is a left-to-right mind map
of the repository's **worktrees** — one node per worktree. Branch off any node
and a real worktree appears; create one from a terminal or an agent and the node
shows up on its own, within a moment.

The Terminal tab is a real shell in that worktree and the File tab browses it.
The agent side is still mocked — the Agent tab replies from a canned pool — and
View and Diff are placeholders. Everything to do with git is real.

---

## Running it

```bash
npm install
npm run start
```

## Scripts

| Script | What it does |
| --- | --- |
| `npm run start` | Runs the app in development with HMR |
| `npm run test` | Unit and integration tests (Vitest, drives real git) |
| `npm run test:e2e` | End-to-end tests (Playwright drives the packaged app) |
| `npm run check` / `npm run fix` | Lint and format (Ultracite / Biome) |
| `npm run package` | Builds an unpackaged app bundle |
| `npm run make` | Builds distributables |

`npm run test:e2e` requires a build: run `npm run package` first.

---

## The model

Three layers, with a strict owner each:

| Layer | Authority | Stored in |
| --- | --- | --- |
| Existence — which nodes exist | git, absolutely | `git worktree list --porcelain` |
| Structure — which node hangs off which | branchwise | `.branchwise/graph.json` |
| Presentation — selection, panel | branchwise | same file |

`graph.json` holds **no node list**. It is an annotation table keyed by branch
name, so the two sides can never disagree — they no longer describe the same
thing.

**A node is a worktree**, not a branch. A branch with no worktree is not on the
canvas: the set stays bounded, and an agent needs a worktree to work in anyway.

**An edge is provenance** — "created from", a historical fact. A rebase does not
move nodes; only you do.

### Where the tree comes from

Git records no parent-branch relationship — after creating two branches,
`git config --get-regexp '^branch\.'` is empty. But it does record origin in the
reflog, whose oldest entry reads `branch: Created from <ref>`:

- `git worktree add -b child <path> parent` → `Created from parent`, exact.
- `git worktree add -b child <path>` → `Created from HEAD`, which needs a
  second step: take the commit it started at and ask which branches contain it,
  preferring the main worktree's branch when several do.

Whatever it works out is **written straight into `graph.json`**, because reflogs
expire after 90 days and cannot serve as storage. If a branch's parent has no
worktree — so is not a node — the chain is walked up until it reaches one that
is. The tree is therefore always connected; there are no orphans.

### Staying in sync

The watcher watches `refs/heads/`, `packed-refs`, `HEAD` and `worktrees/` under
the shared git directory. Filesystem events are treated purely as "something
happened": every one of them triggers a fresh `git worktree list`, diffed
against the last snapshot, and nothing is published unless the diff is
non-empty. branchwise's own writes therefore do not echo back. A five-second
poll backs up `fs.watch`, which is unreliable on some filesystems.

Snapshots reach the renderer as an oRPC event iterator over the existing
MessagePort — no second IPC channel.

Ahead/behind and uncommitted counts are **not** watched. They need `git status`
inside every worktree, so they are read on demand for the selected node only.

---

## What you can do

- **Branch**: hover a node, press `+`, type a name. The draft node is laid out
  as if it already existed, so the tree settles into its final shape while you
  are still typing. The worktree lands in a sibling directory,
  `<repo>.worktrees/<slug>`, which keeps build tools and editors from recursing
  into it. A dirty parent is a warning, not a block — the child starts from the
  parent's last commit, and the editor says so.
- **Rename**: double-click a node. The worktree path is the node's identity, so
  the parent edge survives.
- **Re-parent**: pick a new parent in the panel; its own descendants are left
  out of the list. Dragging the parent end of an edge does the same thing.
- **Remove**: the confirmation lists the worktree path, uncommitted count, merge
  status against the parent and child count. Merged pre-ticks "also delete the
  branch"; unmerged leaves it off and says why. Children are lifted onto the
  grandparent — git does not cascade, and neither should the canvas.
- **Prune**: a worktree whose directory was deleted by hand is shown as missing,
  with a one-click cleanup.
- **Files**: a live file tree beside the file it opens, built on
  [`@pierre/trees`](https://trees.software/). The split is draggable. It tracks
  the disk — create,
  edit or delete a file from a terminal or an agent and the tree and the open
  file follow within a moment, without losing expansion or selection. Source
  files are syntax highlighted with Shiki; markdown renders through tiptap
  rather than showing its own syntax. Binaries and anything over 2 MB say so
  instead of flooding the panel.
- **Terminal**: a real shell, started in that worktree's directory. It belongs
  to the worktree rather than to the view, so switching the panel to Diff and
  back does not kill a running dev server — the scrollback is replayed and the
  same process is still there. It ends when the worktree is removed, the project
  tab closes, or the app quits.

External changes always re-frame the view, but never steal your selection or
what the panel is showing.

---

## Layout of the source

```
src/
  main.ts                  Electron main: window, traffic-light inset, oRPC bootstrap
  ipc/repo/
    command.ts             runGit, with one serial queue per repository
    repo.ts                resolveRepo, listWorktrees, branchOrigin
    mutate.ts              create / remove / rename / prune / status
    watcher.ts             fs watch → re-read git → diff → publish
  lib/git/
    parse.ts               `git worktree list --porcelain` and reflog subjects
    naming.ts              branch-name normalisation and path slugs
    resolve.ts             worktrees + annotations → canvas tree; diffing
  stores/
    tabs-store.ts          Tabs, persisted to localStorage
    repo-store.ts          Per-project snapshot, annotations, mutations
    agent-store.ts         Mock agent conversations (in memory)
  ipc/terminal/
    manager.ts             One shell per worktree: spawn, scrollback, restart
    handlers.ts            attach (stream) / write / resize / restart / kill
  lib/terminal/
    buffer.ts              Bounded scrollback, trimmed on line boundaries
    queue.ts               Ordered, coalescing event queue
  ipc/files/
    scan.ts                Breadth-first walk producing one flat path list
    watcher.ts             Recursive fs.watch → debounce → add/remove events
    handlers.ts            tree / watch / read, boundary-checked
  lib/files/
    scan-policy.ts         Which directories to walk, and the directory marker
    language.ts            Filename → Shiki grammar
    shiki.ts               Lazily created highlighter, grammars on demand
    path-safety.ts         Relative-path normalisation with escape rejection
  components/
    canvas/                React Flow canvas, branch node, delete dialog
    panel/                 Agent / View / Terminal / Diff / File
    workspace/             Folder picker, git-init prompt, loaded project
```

---

## Testing

Three layers, and the middle one carries the weight:

- **Pure units** — porcelain parsing, reflog subjects, tree resolution
  (including the walk-up rule and cycle guards), snapshot diffing, name slugs.
- **Real-git integration** (`*.integration.test.ts`) — a temporary repository per
  test, actual `git worktree add`, and assertions on the tree derived from it.
  This is what surfaced `Created from HEAD`, which no amount of reading
  documentation would have.
- **End-to-end** — Playwright drives the **packaged** app against a real
  repository: nodes appear and disappear as git is driven from outside, and the
  canvas creates and removes worktrees that git then confirms.

---

## What is not built yet

- Real agents: the Agent tab replies from a canned pool and moves task cards
  through `Queued → Running → Done` on timers
- The View and Diff tabs
- Dark mode — the app is pinned to its light surface

## Notes for whoever picks this up

- **The RPC listener must be registered before the window is created.** A
  packaged renderer loads from disk fast enough to hand over its MessagePort
  before a listener added later exists; the port is dropped and every IPC call
  hangs forever. The dev server is slow enough to hide it.
- **oRPC masks non-`ORPCError` throws** as "Internal server error". Anything a
  user needs to read — "a branch named X already exists" — has to be rethrown as
  an `ORPCError` or it never leaves the main process.
- **Zustand selectors must return stable references.** Building a fresh object
  in a selector gives `useSyncExternalStore` a new snapshot every render and
  loops forever.
- **No `memo()` in components.** The React Compiler is enabled and handles it;
  Biome 2.5.3 also panics on `memo()` under the ultracite preset.
- **The main process is not hot-reloaded.** Changes under `src/ipc/` need a full
  `npm run start` restart, not a window reload.
- **node-pty needs three things to survive packaging**, and each fails silently:
  1. The Vite Forge plugin packages only `.vite`, on the assumption everything
     is bundled. A native module cannot be, so `packagerConfig.ignore` has to
     let `node_modules/node-pty` through — see `forge.config.ts`.
  2. `spawn-helper` ships from npm without its executable bit, and node-pty
     execs it. `scripts/fix-native-permissions.mjs` runs on `postinstall` to
     restore it, rather than relying on npm being allowed to run a dependency's
     own lifecycle scripts.
  3. It must be unpacked from the asar, since an executable cannot be run from
     inside an archive.
- **`@pierre/trees` is path-first.** It takes every path up front and has no
  expand-on-demand hook, so the worktree is walked once into a flat list.
  `node_modules` and `.git` are listed but never walked into — descending would
  mean shipping six figures of paths nobody is looking for. Changes are applied
  to the model one path at a time; `resetPaths` would throw away expansion and
  selection on every save.
- **Shiki runs on its JavaScript regex engine, not Oniguruma.** The default
  engine fetches a WebAssembly binary, which is not something to rely on from
  the `file://` origin a packaged renderer runs at.
- **A recursive `fs.watch` is not live the instant it starts.** On macOS there
  is a warm-up before events arrive, so a change made right after attaching is
  missed. The file watcher therefore outlives its last subscriber by ten
  seconds — switching a panel tab away and back reuses a warm watcher instead
  of paying that window again.
- **A path from the renderer is untrusted input.** The File tab names files by
  a path relative to the worktree, so `src/../../..` would otherwise read the
  whole machine. Segment normalisation is not enough on its own: a symlink
  *inside* the worktree passes every textual check, so the resolved target goes
  through `realpath` and is re-checked against the root. `files.integration`
  covers both routes.
- **An app launched from `out/` can hide a packaging bug.** Node resolves
  modules by walking up the filesystem, so it finds the development
  `node_modules` and a missing dependency never surfaces.
  `src/tests/e2e/packaging.test.ts` copies the bundle to a temp directory first;
  `verifyPackagedNatives` also fails the build outright.

---

## Credits

Bootstrapped from [electron-shadcn](https://github.com/LuanRoger/electron-shadcn)
by LuanRoger (MIT). Electron 43, Vite 8, React 19, TypeScript 6, Tailwind 4,
shadcn/ui, TanStack Router, oRPC, Zod, React Flow, dagre, Zustand.
