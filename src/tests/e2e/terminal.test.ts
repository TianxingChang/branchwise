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

const MARKER_LINE = /marker=alive-\d+/;
const EXITED_WITH_3 = /Shell exited with code 3/;
const EXITED_ANY = /Shell exited with code/;

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
let featurePath: string;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-term-"));
  repoPath = path.join(workspace, "demo-repo");
  featurePath = path.join(workspace, "wt-feature");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");
  await git(repoPath, "worktree", "add", "-b", "feature", featurePath, "main");

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

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

function node(label: string) {
  return page.locator(".branchwise-canvas").getByText(label, { exact: true });
}

const screen = () => page.locator(".xterm-screen");

/** Types into the focused terminal and presses return. */
async function runInTerminal(command: string) {
  await screen().click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function openTerminalFor(label: string) {
  await node(label).click();
  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(screen()).toBeVisible({ timeout: 20_000 });
}

test("opens a real shell in the selected worktree", async () => {
  await expect(node("feature")).toBeVisible({ timeout: 20_000 });
  await openTerminalFor("feature");

  // A shell is only useful here if it starts in that worktree, not the repo.
  await runInTerminal("pwd");

  await expect(page.locator(".xterm-rows")).toContainText("wt-feature", {
    timeout: 20_000,
  });
});

test("really executes commands, not an echo of them", async () => {
  await runInTerminal("expr 6 '*' 7");

  await expect(page.locator(".xterm-rows")).toContainText("42", {
    timeout: 20_000,
  });
});

test("the shell survives switching panel tabs", async () => {
  // Leave a marker in the shell's own state, not just on screen.
  await runInTerminal("MARKER=alive-$$");

  await page.getByRole("button", { name: "Diff" }).click();
  await expect(screen()).toBeHidden();

  await page.getByRole("button", { name: "Terminal" }).click();
  await expect(screen()).toBeVisible({ timeout: 20_000 });

  // Scrollback is replayed, so the earlier output is still there...
  await expect(page.locator(".xterm-rows")).toContainText("42", {
    timeout: 20_000,
  });

  // ...and the process itself is the same one, which still holds the variable.
  await runInTerminal('echo "marker=$MARKER"');
  await expect(page.locator(".xterm-rows")).toContainText(MARKER_LINE, {
    timeout: 20_000,
  });
});

test("each worktree gets its own shell", async () => {
  await openTerminalFor("main");
  await runInTerminal("pwd");

  const rows = page.locator(".xterm-rows");
  await expect(rows).toContainText("demo-repo", { timeout: 20_000 });
  // The main worktree's shell has never seen the other one's marker.
  await runInTerminal('echo "here=[$MARKER]"');
  await expect(rows).toContainText("here=[]", { timeout: 20_000 });
});

test("reports an exited shell and can restart it", async () => {
  await openTerminalFor("feature");
  await runInTerminal("exit 3");

  await expect(page.getByText(EXITED_WITH_3)).toBeVisible({
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByText(EXITED_ANY)).toBeHidden({
    timeout: 20_000,
  });

  await runInTerminal("echo restarted-ok");
  await expect(page.locator(".xterm-rows")).toContainText("restarted-ok", {
    timeout: 20_000,
  });
});
