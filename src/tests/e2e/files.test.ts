import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const ROOT_ENTRIES = /^(src|README\.md|\.gitignore|biome\.jsonc|logo\.bin)$/;
const BINARY_NOTICE = /Binary file/;

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

  // A shape worth asserting on: nesting, a dotfile, mixed case, and a binary.
  await mkdir(path.join(repoPath, "src", "lib"), { recursive: true });
  await writeFile(path.join(repoPath, "README.md"), "# demo\nsecond line\n");
  await writeFile(path.join(repoPath, ".gitignore"), "node_modules\n");
  await writeFile(path.join(repoPath, "biome.jsonc"), "{}\n");
  await writeFile(
    path.join(repoPath, "src", "index.ts"),
    'export const answer = 42;\nconsole.log("hello from index");\n'
  );
  await writeFile(
    path.join(repoPath, "src", "lib", "deep.ts"),
    "export const deep = true;\n"
  );
  await writeFile(
    path.join(repoPath, "logo.bin"),
    Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02, 0x03])
  );

  // Something outside the worktree that must stay unreachable.
  await writeFile(path.join(workspace, "outside-secret.txt"), "do not read me");

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

const tree = () => page.getByPlaceholder("Filter files…");

test("lists the worktree with directories before files", async () => {
  await expect(tree()).toBeVisible({ timeout: 20_000 });

  const names = await page
    .getByRole("button")
    .filter({ hasText: ROOT_ENTRIES })
    .allTextContents();

  expect(names[0]).toBe("src");
  expect(names).toContain("README.md");
  expect(names).toContain(".gitignore");
});

test("expands a directory on demand", async () => {
  await expect(page.getByRole("button", { name: "index.ts" })).toBeHidden();

  await page.getByRole("button", { exact: true, name: "src" }).click();

  await expect(page.getByRole("button", { name: "index.ts" })).toBeVisible({
    timeout: 10_000,
  });

  // Nested directories load only when they are opened in turn.
  await expect(page.getByRole("button", { name: "deep.ts" })).toBeHidden();
  await page.getByRole("button", { exact: true, name: "lib" }).click();
  await expect(page.getByRole("button", { name: "deep.ts" })).toBeVisible({
    timeout: 10_000,
  });
});

test("filters files by name while keeping folders in place", async () => {
  await tree().fill("index");

  await expect(page.getByRole("button", { name: "index.ts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "README.md" })).toBeHidden();
  // Folders stay so the branch the match lives in does not collapse away.
  await expect(
    page.getByRole("button", { exact: true, name: "src" })
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear filter" }).click();
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
});

test("opens a file and shows its contents", async () => {
  await page.getByRole("button", { name: "README.md" }).click();

  await expect(page.getByText("second line")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("2 lines", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "← Files" }).click();
  await expect(tree()).toBeVisible();
});

test("refuses to render a binary file as text", async () => {
  await page.getByRole("button", { name: "logo.bin" }).click();

  await expect(page.getByText(BINARY_NOTICE)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "← Files" }).click();
});
