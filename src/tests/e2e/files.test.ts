import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
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

let app: ElectronApplication;
let page: Page;
let workspace: string;
let repoPath: string;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-files-"));
  repoPath = path.join(workspace, "demo-repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await run("git", [...GIT_ENV, "commit", "--allow-empty", "-m", "init"], {
    cwd: repoPath,
  });

  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await mkdir(path.join(repoPath, "node_modules", "left-pad"), {
    recursive: true,
  });
  await writeFile(
    path.join(repoPath, "README.md"),
    "# Demo project\n\nA paragraph with `inline code` and a [link](https://example.com).\n\n- first bullet\n- second bullet\n"
  );
  await writeFile(
    path.join(repoPath, "src", "index.ts"),
    [
      "export const answer = 42;",
      "",
      "function greet(name: string) {",
      "  return name.toUpperCase();",
      "}",
      "",
    ].join("\n")
  );
  await writeFile(
    path.join(repoPath, "node_modules", "left-pad", "index.js"),
    "module.exports = 1;\n"
  );

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

  await page
    .locator(".branchwise-canvas")
    .getByText("main", { exact: true })
    .click();
  await page.getByRole("button", { name: "File" }).click();
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

/**
 * The tree splits a name across elements to style the extension, so a text
 * match would never line up. Its accessible name is the whole filename.
 */
const treeItem = (name: string) =>
  page.getByRole("treeitem", { exact: true, name });

test("renders the worktree with @pierre/trees", async () => {
  await expect(treeItem("README.md")).toBeVisible({ timeout: 30_000 });
  await expect(treeItem("src")).toBeVisible();
});

test("shows a heavy directory without listing its contents", async () => {
  await expect(treeItem("node_modules")).toBeVisible();
  await expect(treeItem("left-pad")).toBeHidden();
});

test("highlights code when a source file is opened", async () => {
  await treeItem("index.ts").click();

  await expect(page.locator(".branchwise-code")).toBeVisible({
    timeout: 30_000,
  });

  // Shiki colours each token inline; plain text would be one bare run.
  const coloured = page.locator(".branchwise-code span[style*='color']");
  await expect(coloured.first()).toBeVisible({ timeout: 30_000 });
  expect(await coloured.count()).toBeGreaterThan(3);
  await expect(page.locator(".branchwise-code")).toContainText("greet");
});

test("renders markdown through tiptap rather than as source", async () => {
  await treeItem("README.md").click();

  const markdown = page.locator(".branchwise-markdown");
  await expect(markdown).toBeVisible({ timeout: 30_000 });

  // Real nodes, not the raw characters: a heading element and list items.
  await expect(markdown.locator("h1")).toHaveText("Demo project");
  await expect(markdown.locator("li")).toHaveCount(2);
  await expect(markdown.locator("code")).toHaveText("inline code");
  await expect(markdown).not.toContainText("# Demo project");
});

test("follows an edit made outside the app", async () => {
  await writeFile(
    path.join(repoPath, "README.md"),
    "# Edited outside\n\nchanged on disk\n"
  );

  await expect(page.locator(".branchwise-markdown h1")).toHaveText(
    "Edited outside",
    { timeout: 30_000 }
  );
});

test("picks up a file created outside the app", async () => {
  await writeFile(
    path.join(repoPath, "src", "added-later.ts"),
    "export const later = true;\n"
  );

  await expect(treeItem("added-later.ts")).toBeVisible({ timeout: 30_000 });
});

test("drops a file deleted outside the app", async () => {
  await unlink(path.join(repoPath, "src", "added-later.ts"));

  await expect(treeItem("added-later.ts")).toBeHidden({ timeout: 30_000 });
});
