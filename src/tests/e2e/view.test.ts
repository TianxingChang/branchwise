import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

interface TestServer {
  hits: () => number;
  port: number;
  stop: () => Promise<void>;
}

/** Serves one marker page and counts how often the app really fetched it. */
function serve(marker: string, port = 0): Promise<TestServer> {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    if (request.url === "/") {
      hits += 1;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><title>bw-view</title><h1>${marker}</h1>`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        hits: () => hits,
        port: (server.address() as AddressInfo).port,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** Finds a port with nothing behind it, for the connection-refused case. */
async function reservePort(): Promise<number> {
  const throwaway = await serve("throwaway");
  const { port } = throwaway;
  await throwaway.stop();
  return port;
}

let app: ElectronApplication;
let page: Page;
let workspace: string;
let repoPath: string;
let featurePath: string;
let featureServer: TestServer;
let deadPort: number;

test.beforeAll(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "branchwise-view-"));
  repoPath = path.join(workspace, "demo-repo");
  featurePath = path.join(workspace, "wt-feature");

  await run("git", [...GIT_ENV, "init", repoPath]);
  await git(repoPath, "commit", "--allow-empty", "-m", "init");
  await git(repoPath, "worktree", "add", "-b", "feature", featurePath, "main");

  featureServer = await serve("feature-marker");
  deadPort = await reservePort();

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
  await featureServer?.stop();
  if (workspace) {
    await rm(workspace, { force: true, recursive: true });
  }
});

function node(label: string) {
  return page.locator(".branchwise-canvas").getByText(label, { exact: true });
}

const addressBar = () => page.getByLabel("Preview address");

async function openViewFor(label: string) {
  await node(label).click();
  await page.getByRole("button", { exact: true, name: "View" }).click();
}

test("loads what the worktree serves", async () => {
  await expect(node("feature")).toBeVisible({ timeout: 20_000 });
  await openViewFor("feature");

  // Nothing configured yet: the tab asks for an address instead of guessing.
  const entry = page.getByPlaceholder("localhost:3000");
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.fill(`localhost:${featureServer.port}`);
  await entry.press("Enter");

  // The server being hit is the proof a real page load happened — the page
  // itself renders in a native view Playwright cannot reach through the DOM.
  await expect.poll(() => featureServer.hits(), { timeout: 20_000 }).toBe(1);

  await expect(addressBar()).toHaveValue(
    `http://localhost:${featureServer.port}/`,
    { timeout: 20_000 }
  );
});

test("keeps the page alive across panel tab switches", async () => {
  const before = featureServer.hits();

  await page.getByRole("button", { exact: true, name: "Diff" }).click();
  await expect(addressBar()).toBeHidden();

  await page.getByRole("button", { exact: true, name: "View" }).click();
  await expect(addressBar()).toHaveValue(
    `http://localhost:${featureServer.port}/`,
    { timeout: 20_000 }
  );

  // Long enough for a reload to have reached the server if one was issued.
  await page.waitForTimeout(800);
  expect(featureServer.hits()).toBe(before);
});

test("reports a dead address and recovers on retry", async () => {
  await openViewFor("main");

  const entry = page.getByPlaceholder("localhost:3000");
  await expect(entry).toBeVisible({ timeout: 20_000 });
  await entry.fill(`localhost:${deadPort}`);
  await entry.press("Enter");

  await expect(page.getByText("Nothing answered")).toBeVisible({
    timeout: 20_000,
  });

  // The dev server comes up late — exactly the case the retry exists for.
  const lateServer = await serve("late-marker", deadPort);
  try {
    await page.getByRole("button", { exact: true, name: "Retry" }).click();

    await expect.poll(() => lateServer.hits(), { timeout: 20_000 }).toBe(1);
    await expect(page.getByText("Nothing answered")).toBeHidden();
  } finally {
    await lateServer.stop();
  }
});

test("remembers a different address per worktree", async () => {
  await node("feature").click();
  await expect(addressBar()).toHaveValue(
    `http://localhost:${featureServer.port}/`,
    { timeout: 20_000 }
  );

  await node("main").click();
  await expect(addressBar()).toHaveValue(`http://localhost:${deadPort}/`, {
    timeout: 20_000,
  });
});
