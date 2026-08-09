# L2 `diff-full` — Review the diff at a width you can actually read

Design spec, 2026-08-09. Aligned with the user in five decisions (grill-me style), sixth question
answered "先不管别的，继续干自己" — remaining calls are Claude's, documented here.

## Decisions (user-confirmed)

1. **Scope: the full L2 increment** as written in the atlas — three panel postures, relative width
   clamp, tab reorder, resize-handle accessibility, and the Diff view in full posture.
2. **Diff base: everything this branch would land.** `git diff <merge-base(parent, HEAD)>` run in the
   node's worktree — committed and uncommitted changes in one view; files with uncommitted changes get
   a small badge. The root node (no parent) degrades to `git diff HEAD` (uncommitted only). L3 (land)
   reuses this plumbing unchanged.
3. **Layout: unified, single column.** Full posture already restores the vertical alignment that
   420px destroyed; side-by-side would reintroduce the wrapping problem at ~60 chars per column.
4. **Implementation: hand-rolled.** Main process runs git; a pure-function parser turns unified
   patch text into a typed model; bespoke React components render it in the bw-* token system.
   No diff library.
5. **Fidelity: shiki highlighting in v1** (lazy, per file); intra-line word diff deferred.

## Decisions (Claude's, per "继续干自己")

- **C3 stays undecided; no tab is cut.** Tab order becomes `agent, diff, terminal, file, view` per
  L2's acceptance criterion. The `view` tab is untouched — a parallel session is actively building it
  (`src/ipc/view/`, `src/types/view.ts` in flight on 2026-08-09).
- **Posture shortcut: `⌘\`** cycles peek → split → full. Esc dismisses in peek posture only.
  Window-level listener in `ProjectWorkspace`, suppressed while focus is in an input, textarea,
  contenteditable, or the xterm host.
- **Posture transitions:** click-a-node opens the panel in **peek**; selecting the Diff tab promotes
  to **full**; leaving the Diff tab while full returns to **split**. The existing `collapsed` state is
  orthogonal and keeps its meaning (panel hidden entirely).
- **Full posture replaces the canvas with a branch rail** (~200px): a flat list of nodes, click to
  switch selection. The xyflow canvas unmounts while full; selection lives in the doc, so remount is
  lossless.
- **Overlay styling is posture-scoped** (atlas watch item): peek keeps rounded/shadow/blur and
  reserves no canvas space; split docks — reserves width, drops the backdrop blur; full fills the
  window beside the rail.
- **Uncommitted badge source:** the diff handler also returns the set of dirty paths from
  `git status --porcelain -z`, so the view marks files that contain uncommitted hunks.

## Architecture

### Main process — `src/ipc/repo/diff.ts` (new)

Two read-only operations, wired as `repo.diff` and `repo.diffSummary` oRPC handlers in
`src/ipc/repo/handlers.ts` (same `os.input().output().handler()` shape as `status`):

- `worktreeDiff({branch, parentBranch, worktreePath})` →
  `{ baseSha, files: FileDiff[], dirtyPaths: string[] }`
  - base = `git merge-base <parentBranch> HEAD` in the worktree; null parent → `HEAD`.
  - patch = `git diff <base> --patch -M --no-color --no-ext-diff --no-textconv` — the last two flags
    keep an untrusted repo's config from executing anything during the read (atlas security edge).
  - Raw patch text is parsed **in the main process** by the pure parser; the renderer receives the
    typed model, not text.
- `worktreeDiffSummary(same input)` → `{ files: number, additions: number, deletions: number }`
  via `git diff <base> --numstat` — cheap enough to refresh on every head/dirty tick for the Agent
  tab strip.

### Parser — `src/lib/git/diff-parse.ts` (new, pure)

`parseUnifiedDiff(text: string): FileDiff[]`. Handles: modify / add / delete, rename headers
(`similarity index`, `rename from/to`) with `-M` detection, binary files (`Binary files … differ`),
mode changes, multiple hunks with old/new line numbering, no trailing newline markers. Fixture-driven
unit tests written first.

### Types — `src/types/diff.ts` (new)

Zod schemas mirroring the branch.ts idiom: `fileDiffSchema` (path, oldPath, kind:
modified|added|deleted|renamed|binary, additions, deletions, dirty, hunks), `diffHunkSchema`
(header, lines), `diffLineSchema` (kind: context|add|del, oldNo, newNo, text), plus
`worktreeDiffSchema` and `diffSummarySchema` for the handler outputs.

### Panel state — `src/types/branch.ts`

`panelStateSchema` gains `posture: z.enum(["peek","split","full"]).default("split")`. The default
makes existing v2 graph docs parse unchanged — no version bump. `PANEL_TABS` reorders to
`["agent","diff","terminal","file","view"]` (ids unchanged, so persisted `panel.tab` values survive).
Store gains `setPanelPosture(folder, posture)` beside the existing panel setters.

### Geometry — `ProjectWorkspace` + `NodePanel`

- peek: `canvasRight = 0`; panel absolute overlay (today's styling).
- split: `canvasRight = width + gutter`; panel loses `backdrop-blur`; resize handle becomes a real
  `role="separator"` with `aria-orientation`, `aria-valuenow/min/max`, `tabIndex=0`, arrow keys
  adjusting by 16px (Shift: 64px).
- full: canvas swapped for `BranchRail` (new component, ~200px); panel takes the remainder.
- Width clamp turns relative: max panel width = `window.innerWidth − max(2 × NODE_WIDTH, 200) − gutters`,
  re-clamped on window resize; MIN stays 340.

### Diff view — `src/components/panel/diff-tab.tsx` (new)

Fetch on mount and on `node.head` change (same trigger discipline as `NodeStats`; stale responses
dropped by an `active` flag). States: loading, error-with-git's-own-words, empty ("No changes against
<parent>"), content. Content: per-file sections with sticky header (path, rename arrow, +/− counts,
dirty badge), collapsible; files over 400 changed lines start collapsed. Hunks render as a single
grid — old/new line-number gutters, marker, code — `+`/`−` rows tinted with bw tokens. Shiki
highlights per file, lazily, when a file is expanded; hunk text is highlighted as a standalone
snippet (grammar-state drift accepted for v1). Long lines: horizontal scroll on the shared container,
never wrapped — wrapping is the failure L2 exists to fix.

### Agent strip — `src/components/panel/agent-tab.tsx`

One compact line under the Agent tab header: `N files +A −D`, from `diffSummary`, refreshed on the
same head trigger; clicking it switches to the Diff tab (which promotes posture to full).

## Testing

1. `diff-parse.test.ts` — fixtures: modify, add, delete, rename, binary, multi-hunk, no-newline,
   empty input. Written before the parser.
2. `git-diff.integration.test.ts` — real temp repo (pattern from `git-repo.integration.test.ts`):
   committed + uncommitted both included against merge-base; rename detected; root-node fallback;
   dirtyPaths correct.
3. `branch-doc.test.ts` extension — old doc without `posture` parses to `split`.
4. Component tests — posture transitions (click→peek, diff→full, leave-diff→split, Esc in peek),
   resize handle keyboard, DiffTab states on a mocked action.

## Out of scope

Intra-line word diff, side-by-side toggle, virtualized rendering, base-picker UI, the live
"diff so far" agent strip (IDEAS: adopt later), any change to the `view` tab.
