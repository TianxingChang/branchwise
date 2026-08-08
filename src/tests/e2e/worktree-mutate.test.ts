import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";

const run = promisify(execFile);

const UNCOMMITTED = /uncommitted change/;

const GIT_ENV = [
  "-c",
  "user.email=test@branchwise.local",
  "-c",
  "user.name=branchwise test",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "init.defaultBranch=main",
];

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await run("git", [...GIT_ENV, ...args], { cwd });
  return stdout;
}

let app: ElectronApplication;
let page: Page;
let workspace: string;
let repoPath: string;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-mutate-"));
  repoPath = path.join(workspace, "demo-repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");

  const appInfo = parseElectronApp(findLatestBuild());
  app = await electron.launch({
    args: [
      appInfo.main,
      `--user-data-dir=${path.join(workspace, "user-data")}`,
    ],
  });

  page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(error));

  await page.evaluate(
    (project) => {
      localStorage.setItem(
        "branchwise.tabs",
        JSON.stringify({
          state: { activeTabId: "tab_e2e", tabs: [{ id: "tab_e2e", project }] },
          version: 0,
        })
      );
    },
    { name: "demo-repo", path: repoPath }
  );

  await page.reload();
  await expect(node("main")).toBeVisible({
    timeout: 20_000,
  });
});

/**
 * The + only becomes interactive while its node is hovered, so the hover is
 * part of the interaction rather than test scaffolding.
 */
async function startBranchFrom(label: string) {
  await node(label).hover();
  await page.getByRole("button", { name: `Branch from ${label}` }).click();
}

/**
 * Scoped to the canvas: a selected branch's name also appears in the panel
 * header, and an unscoped text match would hit both.
 */
function node(label: string) {
  return page.locator(".branchwise-canvas").getByText(label, { exact: true });
}

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

/** Waits for the canvas to stop animating before trusting a coordinate. */
async function settledBox(locator: ReturnType<typeof page.locator>) {
  let previous: string | null = null;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    // Sampling is sequential by nature: each read has to follow the last.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    const box = await locator.boundingBox();
    const serialised = JSON.stringify(box);
    if (box && serialised === previous) {
      return box;
    }
    previous = serialised;
    await page.waitForTimeout(100);
  }

  throw new Error("element never stopped moving");
}

/**
 * Walks the pointer from inside the node out to the +, one small step at a
 * time.
 *
 * Playwright's click() teleports to the target, which is exactly why the
 * earlier tests passed while the button was unusable with a real mouse: the
 * hover chain only breaks when the pointer actually traverses the gap between
 * the card and the button.
 */
test("the + stays reachable when the pointer travels to it", async () => {
  const card = await settledBox(
    page.locator(".react-flow__node", { hasText: "main" })
  );

  const startX = card.x + card.width - 12;
  const midY = card.y + card.height / 2;
  const plus = await settledBox(
    page.getByRole("button", { name: "Branch from main" })
  );
  const endX = plus.x + plus.width / 2;

  await page.mouse.move(startX, midY);
  const steps = 24;
  for (let step = 1; step <= steps; step += 1) {
    // Ordered by definition: this is one continuous pointer path.
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await page.mouse.move(startX + ((endX - startX) * step) / steps, midY);
  }

  // If the hover chain broke on the way, the + has faded out and stopped
  // receiving pointer events — this click is what fails.
  const plusButton = page.getByRole("button", { name: "Branch from main" });
  await expect(plusButton).toBeVisible();
  await plusButton.click({ timeout: 5000 });

  await expect(page.getByPlaceholder("branch name")).toBeVisible({
    timeout: 10_000,
  });
  await page.getByPlaceholder("branch name").press("Escape");
});

test("creates a real branch and worktree from the canvas", async () => {
  await startBranchFrom("main");
  await page.getByPlaceholder("branch name").fill("feat/from-canvas");
  await page.getByPlaceholder("branch name").press("Enter");

  await expect(node("feat/from-canvas")).toBeVisible({
    timeout: 20_000,
  });

  // Not just a node: git and the filesystem must actually agree.
  const worktrees = await git(repoPath, "worktree", "list", "--porcelain");
  expect(worktrees).toContain("refs/heads/feat/from-canvas");

  const expectedPath = path.join(`${repoPath}.worktrees`, "feat-from-canvas");
  expect(existsSync(expectedPath)).toBe(true);
});

test("records the new branch's parent in graph.json", async () => {
  const graphPath = path.join(repoPath, ".branchwise", "graph.json");

  // The write is debounced, so wait for it rather than racing it.
  await expect
    .poll(
      () => {
        if (!existsSync(graphPath)) {
          return "not written yet";
        }
        return JSON.parse(readFileSync(graphPath, "utf8")).branches[
          "feat/from-canvas"
        ]?.parent;
      },
      { timeout: 10_000 }
    )
    .toBe("main");
});

test("refuses a branch name that already exists", async () => {
  await startBranchFrom("main");
  await page.getByPlaceholder("branch name").fill("feat/from-canvas");
  await page.getByPlaceholder("branch name").press("Enter");

  await expect(page.getByRole("status")).toContainText("already exists", {
    timeout: 10_000,
  });
});

test("removes the worktree and keeps the branch when told to", async () => {
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/keeper",
    path.join(workspace, "wt-keeper"),
    "main"
  );
  await expect(node("feat/keeper")).toBeVisible({
    timeout: 20_000,
  });

  await node("feat/keeper").hover();
  await page.getByRole("button", { name: "Remove feat/keeper" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Merged into main (no commits of its own), so the box is pre-ticked.
  const checkbox = dialog.getByRole("checkbox");
  await expect(checkbox).toBeChecked({ timeout: 10_000 });
  await checkbox.uncheck();
  await dialog.getByRole("button", { name: "Remove" }).click();

  await expect(node("feat/keeper")).toBeHidden({
    timeout: 20_000,
  });

  const branches = await git(repoPath, "branch", "--format=%(refname:short)");
  expect(branches).toContain("feat/keeper");
});

test("deletes the branch too when the box stays ticked", async () => {
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/doomed",
    path.join(workspace, "wt-doomed"),
    "main"
  );
  await expect(node("feat/doomed")).toBeVisible({
    timeout: 20_000,
  });

  await node("feat/doomed").hover();
  await page.getByRole("button", { name: "Remove feat/doomed" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox")).toBeChecked({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "Remove" }).click();

  await expect(node("feat/doomed")).toBeHidden({
    timeout: 20_000,
  });

  const branches = await git(repoPath, "branch", "--format=%(refname:short)");
  expect(branches).not.toContain("feat/doomed");
});

test("warns before branching off a worktree with uncommitted changes", async () => {
  await run("sh", ["-c", `echo dirty > ${path.join(repoPath, "scratch.txt")}`]);

  await startBranchFrom("main");

  await expect(page.getByText(UNCOMMITTED)).toBeVisible({
    timeout: 10_000,
  });

  await page.getByPlaceholder("branch name").press("Escape");
});
