import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  attach,
  history,
  respondPermissionRoute,
  sendMessage,
} from "@/ipc/agent/handlers";
import {
  _resetManagerForTests,
  configureManager,
  setConfig,
} from "@/ipc/agent/manager";
import { puppetDriver } from "./helpers/puppet-driver";

let base = "";
const WT = "/wt/feat-x";

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-handlers-"));
});
afterEach(async () => {
  _resetManagerForTests();
  await rm(base, { force: true, recursive: true });
});

describe("agent handlers", () => {
  test("send + history round-trip through the oRPC layer", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });

    const send = sendMessage.callable();
    expect(await send({ text: "hello", worktreePath: WT })).toEqual({
      accepted: true,
    });
    puppet.feed({
      costUsd: null,
      kind: "turn-done",
      stopReason: "completed",
      turnId: "t1",
      usage: null,
    });
    puppet.end();
    await new Promise((resolve) => setTimeout(resolve, 80));

    const readBack = await history.callable()({ worktreePath: WT });
    expect(readBack.map((event) => event.kind)).toEqual([
      "user-message",
      "turn-done",
    ]);
  });

  test("attach replays then ends when the client aborts", async () => {
    const puppet = puppetDriver();
    configureManager({
      baseDir: base,
      drivers: { "claude-code": puppet.driver },
    });
    await setConfig(WT, { driverId: "claude-code", tier: "accept-edits" });
    await sendMessage.callable()({ text: "hi", worktreePath: WT });

    const controller = new AbortController();
    const stream = await attach.callable()(
      { worktreePath: WT },
      { signal: controller.signal }
    );
    const seen: string[] = [];
    const consuming = (async () => {
      for await (const event of stream) {
        seen.push(event.kind);
        if (seen.length >= 1) {
          controller.abort();
        }
      }
    })().catch(() => {
      // Ignore the abort error
    });
    await consuming;
    expect(seen[0]).toBe("user-message");
    puppet.end();
  });

  test("empty text is refused", async () => {
    configureManager({ baseDir: base, drivers: {} });
    const result = await sendMessage.callable()({
      text: "   ",
      worktreePath: WT,
    });
    expect(result.accepted).toBe(false);
  });

  test("responding to an unknown permission returns ok:false", async () => {
    configureManager({ baseDir: base, drivers: {} });
    const result = await respondPermissionRoute.callable()({
      approved: true,
      requestId: "nope",
      worktreePath: WT,
    });
    expect(result.ok).toBe(false);
  });
});
