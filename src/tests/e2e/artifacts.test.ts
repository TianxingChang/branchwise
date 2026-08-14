import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const shelfFile = (name: string) =>
  path.join(repoPath, ".branchwise", "artifacts", name);

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-artifacts-"));
  repoPath = path.join(workspace, "demo-repo");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await run("git", [...GIT_ENV, "commit", "--allow-empty", "-m", "init"], {
    cwd: repoPath,
  });

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
  await page.getByRole("button", { exact: true, name: "Artifact" }).click();
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

test("an empty shelf says so", async () => {
  await expect(
    page.getByText("Nothing here yet", { exact: false })
  ).toBeVisible({ timeout: 30_000 });
});

test("a note autosaves what is typed into it", async () => {
  await page.getByRole("button", { exact: true, name: "Note" }).click();

  // The fresh note opens straight into the editor.
  const editor = page.locator(".branchwise-markdown[contenteditable='true']");
  await expect(editor).toBeVisible({ timeout: 30_000 });

  await editor.click();
  await page.keyboard.type("Plan: ship the artifact shelf");

  // The debounce is 350ms; the file is the proof, not the DOM.
  await expect
    .poll(() => readFile(shelfFile("Note.md"), "utf8").catch(() => null), {
      timeout: 15_000,
    })
    .toContain("Plan: ship the artifact shelf");
});

test("a canvas renders tldraw and saves what is drawn", async () => {
  await page.getByRole("button", { exact: true, name: "Canvas" }).click();

  // tldraw's editor container — proof the lazy chunk arrived and mounted.
  const canvas = page.locator(".tl-container");
  await expect(canvas).toBeVisible({ timeout: 30_000 });

  const bounds = await canvas.boundingBox();
  if (!bounds) {
    throw new Error("tldraw container has no size");
  }

  // Draw a rectangle: keyboard picks the geo tool, then a drag on the canvas.
  await canvas.click();
  await page.keyboard.press("r");
  const startX = bounds.x + bounds.width / 2 - 40;
  const startY = bounds.y + bounds.height / 2 - 30;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY + 60, { steps: 5 });
  await page.mouse.up();

  // A geo shape in the saved snapshot proves edit → store → autosave → disk.
  await expect
    .poll(() => readFile(shelfFile("Canvas.tldr"), "utf8").catch(() => null), {
      timeout: 15_000,
    })
    .toContain('"geo"');
});

test("both artifacts sit on the shelf afterwards", async () => {
  const rows = page.getByRole("listitem");
  await expect(rows.filter({ hasText: "Note" }).first()).toBeVisible();
  await expect(rows.filter({ hasText: "Canvas" }).first()).toBeVisible();
});
