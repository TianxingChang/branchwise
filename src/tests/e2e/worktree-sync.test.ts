import { execFile } from "node:child_process";
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
  await run("git", [...GIT_ENV, ...args], { cwd });
}

let app: ElectronApplication;
let page: Page;
let workspace: string;
let repoPath: string;
let userDataDir: string;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-e2e-"));
  userDataDir = path.join(workspace, "user-data");
  repoPath = path.join(workspace, "demo-repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");

  const appInfo = parseElectronApp(findLatestBuild());
  app = await electron.launch({
    // A dedicated profile keeps this run's seeded tab out of the other suites.
    args: [appInfo.main, `--user-data-dir=${userDataDir}`],
  });

  page = await app.firstWindow();
  page.on("pageerror", (error) => console.error(error));

  // Seed the tab the folder picker would otherwise have created. This is the
  // app's own persisted format, so nothing test-only is compiled into the app.
  await page.evaluate(
    (project) => {
      localStorage.setItem(
        "branchwise.tabs",
        JSON.stringify({
          state: {
            activeTabId: "tab_e2e",
            tabs: [{ id: "tab_e2e", project }],
          },
          version: 0,
        })
      );
    },
    { name: "demo-repo", path: repoPath }
  );

  await page.reload();
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("renders the repository's main worktree as the root node", async () => {
  await expect(page.getByText("main", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("shows a worktree created outside the app, live", async () => {
  await expect(page.getByText("main", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // Exactly what an agent shelling out to git would do, while the app watches.
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/live",
    path.join(workspace, "wt-live"),
    "main"
  );

  await expect(page.getByText("feat/live", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
});

test("drops the node again when the worktree is removed outside the app", async () => {
  await expect(page.getByText("feat/live", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  await git(repoPath, "worktree", "remove", path.join(workspace, "wt-live"));

  await expect(page.getByText("feat/live", { exact: true })).toBeHidden({
    timeout: 20_000,
  });
});

test("opens the panel for a node and keeps it through an external change", async () => {
  await page.getByText("main", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Hide branch panel" })
  ).toBeVisible();

  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "feat/second",
    path.join(workspace, "wt-second"),
    "main"
  );

  await expect(page.getByText("feat/second", { exact: true })).toBeVisible({
    timeout: 20_000,
  });

  // The external change must not steal the selection.
  await expect(
    page.getByRole("button", { name: "Hide branch panel" })
  ).toBeVisible();
});
