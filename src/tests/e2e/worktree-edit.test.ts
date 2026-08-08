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
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-edit-"));
  repoPath = path.join(workspace, "demo-repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");

  // main → alpha → beta, so beta can be dragged up onto main.
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "alpha",
    path.join(workspace, "wt-alpha"),
    "main"
  );
  await git(
    path.join(workspace, "wt-alpha"),
    "commit",
    "--allow-empty",
    "-m",
    "a1"
  );
  await git(
    repoPath,
    "worktree",
    "add",
    "-b",
    "beta",
    path.join(workspace, "wt-beta"),
    "alpha"
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
});

function node(label: string) {
  return page.locator(".branchwise-canvas").getByText(label, { exact: true });
}

/** The doc is written on a debounce, so treat "not there yet" as empty. */
function graphDoc(): {
  branches: Record<
    string,
    { parent: string; parentSource: string } | undefined
  >;
} {
  const file = path.join(repoPath, ".branchwise", "graph.json");
  if (!existsSync(file)) {
    return { branches: {} };
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("infers the chain main → alpha → beta from git alone", async () => {
  await expect(node("beta")).toBeVisible({ timeout: 20_000 });

  await expect
    .poll(() => graphDoc().branches.beta?.parent, { timeout: 10_000 })
    .toBe("alpha");
  expect(graphDoc().branches.beta?.parentSource).toBe("reflog");
});

test("shows ahead/behind for the selected node", async () => {
  await node("alpha").click();

  // alpha has one commit main does not.
  await expect(page.getByTitle("commits ahead of parent")).toContainText("1", {
    timeout: 15_000,
  });
});

test("renames a branch on double click and keeps its parent edge", async () => {
  await node("beta").dblclick();

  const input = page.getByPlaceholder("branch name");
  await expect(input).toHaveValue("beta");
  await input.fill("beta-renamed");
  await input.press("Enter");

  await expect(node("beta-renamed")).toBeVisible({ timeout: 20_000 });

  const branches = await git(repoPath, "branch", "--format=%(refname:short)");
  expect(branches).toContain("beta-renamed");
  expect(branches).not.toContain("\nbeta\n");

  // The worktree path survives the rename, so the parent edge rides along.
  await expect
    .poll(() => graphDoc().branches["beta-renamed"]?.parent, {
      timeout: 10_000,
    })
    .toBe("alpha");
});

test("re-parents a node from the panel", async () => {
  await node("beta-renamed").click();

  const picker = page.getByLabel("Branches from");
  await expect(picker).toHaveValue("alpha");
  await picker.selectOption("main");

  await expect
    .poll(() => graphDoc().branches["beta-renamed"]?.parent, {
      timeout: 15_000,
    })
    .toBe("main");
  expect(graphDoc().branches["beta-renamed"]?.parentSource).toBe("user");
});

test("keeps a node's own descendants out of its parent choices", async () => {
  await node("alpha").click();

  const options = await page
    .getByLabel("Branches from")
    .locator("option")
    .allTextContents();

  expect(options).toContain("main");
  // beta-renamed hangs off main now, so it is a legal choice again; what must
  // never appear is a branch that descends from alpha.
  await node("main").click();
  await expect(page.getByLabel("Branches from")).toBeHidden();
});
