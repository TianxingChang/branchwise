import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { _electron as electron, expect, test } from "@playwright/test";
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

/**
 * Runs the built app from outside the project directory.
 *
 * Node resolves modules by walking *up* the filesystem, so an app launched from
 * `out/` inside the project happily finds the development `node_modules` and a
 * missing native dependency stays invisible. Copying the bundle somewhere else
 * first is the only way this test can fail when packaging is wrong.
 */
// Copies a 350 MB bundle, launches it cold and drives a shell, and its own
// waits are 30s each — the default per-test budget cannot cover that.
test.setTimeout(120_000);

test("the packaged app carries its own node-pty and can open a shell", async () => {
  const build = findLatestBuild();
  const staging = await mkdtemp(path.join(tmpdir(), "branchwise-install-"));

  try {
    const installed = path.join(staging, path.basename(build));
    await run("cp", ["-R", build, installed]);

    const repoPath = path.join(staging, "repo");
    await run("git", [...GIT_ENV, "init", repoPath]);
    await run("git", [...GIT_ENV, "commit", "--allow-empty", "-m", "init"], {
      cwd: repoPath,
    });

    const appInfo = parseElectronApp(installed);
    expect(appInfo.main.startsWith(staging)).toBe(true);

    const resources = path.join(
      path.dirname(path.dirname(appInfo.executable)),
      "Resources"
    );
    expect(
      existsSync(
        path.join(resources, "app.asar.unpacked", "node_modules", "node-pty")
      )
    ).toBe(true);

    const app = await electron.launch({
      args: [
        appInfo.main,
        `--user-data-dir=${path.join(staging, "user-data")}`,
      ],
    });

    try {
      const page = await app.firstWindow();
      page.on("pageerror", (error) => console.error(error));

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
        { name: "repo", path: repoPath }
      );
      await page.reload();

      const canvas = page.locator(".branchwise-canvas");
      await expect(canvas.getByText("main", { exact: true })).toBeVisible({
        timeout: 30_000,
      });

      await canvas.getByText("main", { exact: true }).click();
      await page.getByRole("button", { name: "Terminal" }).click();

      const screen = page.locator(".xterm-screen");
      await expect(screen).toBeVisible({ timeout: 30_000 });

      await screen.click();
      await page.keyboard.type("echo packaged-shell-ok");
      await page.keyboard.press("Enter");

      await expect(page.locator(".xterm-rows")).toContainText(
        "packaged-shell-ok",
        { timeout: 30_000 }
      );
    } finally {
      await app.close();
    }
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
});
