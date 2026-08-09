import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  listPids,
  reapStrays,
  registerPid,
  unregisterPid,
} from "@/ipc/agent/pids";

let base = "";
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "bw-pids-"));
});
afterEach(async () => {
  await rm(base, { force: true, recursive: true });
});

describe("pid registry", () => {
  test("register, list, unregister round-trip", async () => {
    await registerPid(base, 1111);
    await registerPid(base, 2222);
    expect(await listPids(base)).toEqual([1111, 2222]);
    await unregisterPid(base, 1111);
    expect(await listPids(base)).toEqual([2222]);
  });

  test("reap kills a live stray and clears the file", async () => {
    const child = spawn("sleep", ["30"]);
    const { pid } = child;
    expect(pid).toBeDefined();
    if (pid === undefined) {
      return;
    }
    await registerPid(base, pid);
    await registerPid(base, 9_999_999); // long dead / never existed
    const killed = await reapStrays(base);
    expect(killed).toEqual([pid]);
    expect(await listPids(base)).toEqual([]);
    // reapStrays's SIGKILL, plus the fs work it does afterward, is often
    // enough real time for the OS to reap the child and for Node to record
    // it (exitCode/signalCode set) before we get here — in which case the
    // 'exit' event has already fired and a bare `once` would wait forever
    // for an event that will not come a second time.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  });
});
