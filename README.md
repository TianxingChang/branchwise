# branchwise

A desktop workspace for coding across many git branches at once.

Each tab is a project folder. Inside a project, the canvas is a left-to-right
mind map where **every node is a branch** — branch off any node, click a node to
open its panel, and drive an agent on that branch without leaving the map.

This repository currently contains **the frontend only**. Branches are not
created in git, no agent process is spawned, and the terminal, diff, view and
file tabs are placeholders. What is real: the window chrome, the tab model, the
folder picker, the branch tree, the auto-layout, the panel, and persistence to
disk.

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
| `npm run test` | Unit tests (Vitest) |
| `npm run test:e2e` | End-to-end tests (Playwright + Electron) |
| `npm run check` / `npm run fix` | Lint and format (Ultracite / Biome) |
| `npm run package` | Builds an unpackaged app bundle |
| `npm run make` | Builds distributables |

---

## How it works

### The tree is the only source of truth

A branch node stores `{ id, name, parentId, status, stats }` — never a position.
Positions are recomputed from the tree by dagre (`rankdir: LR`) on every change,
so adding or deleting a branch makes the whole map re-settle. Nodes are
therefore not draggable by design: there is no manual position to preserve. The
view re-frames itself when the tree's shape changes and when the canvas is
resized — panning and zooming in between are left alone.

```
tree ──dagre(LR)──▶ positions ──▶ React Flow
  │
  └──debounced 300ms──▶ oRPC ──▶ main process ──▶ <project>/.branchwise/graph.json
```

### Creating a branch

Hovering a node pulls a dashed stub and a `+` out of its right edge. Clicking it
inserts a **draft node** into the tree that the layout engine positions as if it
already existed, so the map settles into its final shape while you are still
typing the name. Enter commits, Escape cancels. Names are folded into something
git would accept as a ref (`Add login flow` → `Add-login-flow`) and checked for
collisions. Double-clicking a node renames it through the same editor.

### Persistence

Per project, `<project>/.branchwise/graph.json` holds the tree, the selection,
and the panel state. It is validated with Zod on read; a file describing an
impossible tree (a node whose parent was hand-deleted) is repaired by dropping
the unreachable nodes rather than discarding the user's graph.

The viewport is deliberately **not** persisted. A frame saved against one canvas
width is wrong at the next one — reopening a project would drop branches behind
the panel — so the tree is simply framed on open.

Agent conversations are deliberately **not** persisted — they are mock data
today, and writing them into someone's repository would be noise.

Open tabs live in `localStorage` and are restored on launch. Tabs whose folder
has since moved are dropped at startup.

---

## Layout of the source

```
src/
  main.ts                  Electron main: window, traffic-light inset, oRPC bootstrap
  ipc/project/             pickProjectFolder / loadGraph / saveGraph / projectExists
  lib/branch/
    tree.ts                Pure tree operations — add, rename, remove subtree, name rules
    layout.ts              dagre left-to-right layout; returns top-left corners
    doc.ts                 Validation and repair of graph.json
  stores/
    tabs-store.ts          Tabs, persisted to localStorage
    graph-store.ts         Per-project graph, debounced save through oRPC
    agent-store.ts         Mock agent conversations (in memory)
  components/
    app-shell.tsx          Tab strip + active workspace
    canvas/                React Flow canvas and the branch node
    panel/                 Floating node panel: Agent / View / Terminal / Diff / File
    workspace/             Folder picker empty state and the loaded project view
```

The pure modules under `lib/branch/` carry the unit tests
(`src/tests/unit/branch-*.test.ts`), which is where the interesting behaviour
lives — layout ordering, subtree deletion, name normalization, doc repair.

---

## What is not built yet

- Real git: no worktrees, no branch creation, no diffing
- Real agents: the Agent tab replies from a canned pool and moves task cards
  through `Queued → Running → Done` on timers
- The View, Terminal, Diff and File tabs
- Dark mode — the app is pinned to its light surface

## Notes for whoever picks this up

- **No `memo()` in components.** The React Compiler is enabled, so it handles
  memoization. Biome 2.5.3 also panics on `memo()` under the ultracite preset.
- **Zustand selectors must return stable references.** Selecting a freshly built
  object gives `useSyncExternalStore` a new snapshot every render and loops
  forever. `BranchCardBody` selects the items array and derives its counts with
  `useMemo` for exactly this reason.
- **The main process is not hot-reloaded.** Changes under `src/ipc/` or
  `src/lib/branch/doc.ts` need a full `npm run start` restart, not a window
  reload.

---

## Credits

Bootstrapped from [electron-shadcn](https://github.com/LuanRoger/electron-shadcn)
by LuanRoger (MIT). Electron 43, Vite 8, React 19, TypeScript 6, Tailwind 4,
shadcn/ui, TanStack Router, oRPC, Zod, React Flow, dagre, Zustand.
