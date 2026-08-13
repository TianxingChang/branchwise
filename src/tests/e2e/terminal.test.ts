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
const CLOSE_PANE = /^Close terminal/;
const BACK_IN_FIRST_TAB = /back=\[tab-\d+\]/;
/** The tab chips inside a pane. Ids never repeat, so never assume a number. */
const TAB_CHIP = /^Terminal \d+$/;
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
  await page.getByRole("button", { exact: true, name: "Terminal" }).click();
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

  await page.getByRole("button", { exact: true, name: "Terminal" }).click();
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

/** The split control inside a given pane's own header. */
function splitButton(pane: number, orientation: "horizontal" | "vertical") {
  const label =
    orientation === "vertical"
      ? "Split left and right"
      : "Split top and bottom";
  return page.getByRole("button", { name: label }).nth(pane);
}

function closeButton(pane: number) {
  return page.getByRole("button", { name: CLOSE_PANE }).nth(pane);
}

const panes = () => page.locator(".xterm-screen");

async function typeInPane(pane: number, command: string) {
  await panes().nth(pane).click();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test("splitting a pane opens a second, independent shell", async () => {
  await openTerminalFor("feature");
  await runInTerminal("SECOND=no-$$");

  await splitButton(0, "vertical").click();
  await expect(panes()).toHaveCount(2, { timeout: 20_000 });

  // A split is only worth anything if it is a second process. If the key
  // scheme had collided, this pane would know the variable the first just set.
  await typeInPane(1, 'echo "second=[$SECOND]"');
  await expect(page.locator(".xterm-rows").nth(1)).toContainText("second=[]", {
    timeout: 20_000,
  });

  await closeButton(1).click();
  await expect(panes()).toHaveCount(1, { timeout: 20_000 });
});

test("a pane holds its own tabs, without dividing the room", async () => {
  await runInTerminal("FIRST=tab-$$");
  const tabs = page.getByTitle(TAB_CHIP);
  await expect(tabs).toHaveCount(1);

  await page.getByRole("button", { name: "New terminal" }).nth(0).click();
  await expect(tabs).toHaveCount(2);
  // A tab costs no room: still one pane.
  await expect(panes()).toHaveCount(1);

  // ...but it is a separate process, which never saw the first tab's variable.
  await typeInPane(0, 'echo "first=[$FIRST]"');
  await expect(page.locator(".xterm-rows")).toContainText("first=[]", {
    timeout: 20_000,
  });

  // Going back to the first tab finds that shell still holding its variable.
  await tabs.nth(0).click();
  await typeInPane(0, 'echo "back=[$FIRST]"');
  await expect(page.locator(".xterm-rows")).toContainText(BACK_IN_FIRST_TAB, {
    timeout: 20_000,
  });

  await closeButton(1).click();
  await expect(tabs).toHaveCount(1);
  await expect(panes()).toHaveCount(1);
});

test("a pane that is already half a split can split again", async () => {
  await splitButton(0, "vertical").click();
  await expect(panes()).toHaveCount(2, { timeout: 20_000 });

  // The second pane divides on its own, which a flat two-pane model cannot do.
  await splitButton(1, "horizontal").click();
  await expect(panes()).toHaveCount(3, { timeout: 20_000 });
});

test("closing a pane collapses its split and leaves the sibling", async () => {
  await closeButton(2).click();
  await expect(panes()).toHaveCount(2, { timeout: 20_000 });

  await closeButton(1).click();
  await expect(panes()).toHaveCount(1, { timeout: 20_000 });

  // The last pane has no close control: the tab always shows a terminal.
  await expect(page.getByRole("button", { name: CLOSE_PANE })).toHaveCount(0);
});

test("refuses a split that would leave a pane too narrow to use", async () => {
  // The docked panel is about 54 columns. One split gives 26; a second would
  // give 12, below what a themed prompt can draw — which is exactly the
  // overflow that garbles the output.
  await splitButton(0, "vertical").click();
  await expect(panes()).toHaveCount(2, { timeout: 20_000 });

  await expect(splitButton(0, "vertical")).toBeDisabled();
  // Height is gated separately, and there is still room to stack.
  await expect(splitButton(0, "horizontal")).toBeEnabled();

  await closeButton(1).click();
  await expect(panes()).toHaveCount(1, { timeout: 20_000 });
});

test("every pane's shell is told the width its pane actually has", async () => {
  // The garbling this guards against is width-dependent output: a prompt drawn
  // for 54 columns inside a 26-column pane overflows into runs of repeated
  // characters. That only stays fixed while every pty tracks its own pane.
  const widthIn = async (pane: number, token: string) => {
    // stty reads the tty ioctl directly; tput/ncurses would honour $COLUMNS.
    // The token is split so the echoed command cannot match its own regex,
    // and unique per call so an earlier answer in the scrollback cannot.
    await typeInPane(pane, `echo "${token}""=$(stty size | cut -d\\  -f2)"`);

    const rows = page.locator(".xterm-rows").nth(pane);
    await expect(rows).toContainText(new RegExp(`${token}=\\d+`), {
      timeout: 20_000,
    });

    // Read the last answer, not the first: the command line the shell echoed
    // is on screen too, and an earlier pane's reply may be in the scrollback.
    const text = await rows.innerText();
    const marker = `${token}=`;
    return Number.parseInt(
      text.slice(text.lastIndexOf(marker) + marker.length),
      10
    );
  };

  const whole = await widthIn(0, "WA");

  await splitButton(0, "vertical").click();
  await expect(panes()).toHaveCount(2, { timeout: 20_000 });

  const left = await widthIn(0, "WB");
  const right = await widthIn(1, "WC");

  // Halving the pane must reach the shell that was already open, not just the
  // one spawned for the new half.
  expect(left).toBeLessThan(whole);
  expect(left).toBe(right);

  await closeButton(1).click();
  await expect(panes()).toHaveCount(1, { timeout: 20_000 });
});

test("a shell does not inherit the launcher's package-manager environment", async () => {
  // This suite runs the app from `npx playwright test`, so npm has put
  // npm_config_prefix into the process branchwise inherits — the same thing
  // `npm start` does. Leaking it made nvm warn on every new shell.
  await openTerminalFor("feature");
  await typeInPane(0, 'echo "PRE""FIX=[$npm_config_prefix]:[$INIT_CWD]"');

  await expect(page.locator(".xterm-rows")).toContainText("PREFIX=[]:[]", {
    timeout: 20_000,
  });
});
