/** Characters git refuses in a ref name, plus whitespace we fold into dashes. */
const INVALID_REF_CHARS = /[\s~^:?*[\]\\]+/g;
const REF_REPEATED_DASHES = /-{2,}/g;
const REF_TRIMMABLE_EDGES = /^[-./]+|[-./]+$/g;

const UNSAFE_PATH_CHARS = /[^a-zA-Z0-9._-]+/g;
const SLUG_REPEATED_DASHES = /-{2,}/g;
const SLUG_TRIMMABLE_EDGES = /^[-.]+|[-.]+$/g;

/**
 * Folds arbitrary user input into something git would accept as a branch name.
 * Returns an empty string when nothing usable survives.
 */
export function normalizeBranchName(input: string): string {
  return input
    .trim()
    .replace(INVALID_REF_CHARS, "-")
    .replace(REF_REPEATED_DASHES, "-")
    .replace(REF_TRIMMABLE_EDGES, "");
}

/**
 * Flattens a branch name into a single directory name.
 *
 * `feat/a` becomes `feat-a` rather than a nested directory, so the worktree
 * root never grows a tree of empty parent folders and a branch can never
 * collide with a directory created for another branch's namespace.
 */
export function slugForBranch(branch: string): string {
  const slug = branch
    .replace(UNSAFE_PATH_CHARS, "-")
    .replace(SLUG_REPEATED_DASHES, "-")
    .replace(SLUG_TRIMMABLE_EDGES, "");

  return slug.length > 0 ? slug : "branch";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Label shown on a node when the worktree has no branch checked out. */
export function detachedLabel(head: string): string {
  return `detached @ ${shortSha(head)}`;
}
