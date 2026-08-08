import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Restores the executable bit on node-pty's `spawn-helper`.
 *
 * The prebuilt tarball ships it as 0644, and node-pty shells out to it through
 * posix_spawnp — so without this every spawn fails with "posix_spawnp failed".
 * node-pty's own post-install would fix it, but that only runs when npm is
 * allowed to execute dependency lifecycle scripts, which is not a safe thing to
 * depend on.
 */
const PREBUILDS = path.join("node_modules", "node-pty", "prebuilds");

async function main() {
  let platforms;
  try {
    platforms = await readdir(PREBUILDS);
  } catch {
    return; // node-pty is not installed; nothing to repair.
  }

  await Promise.all(
    platforms.map(async (platform) => {
      const helper = path.join(PREBUILDS, platform, "spawn-helper");
      try {
        await stat(helper);
        await chmod(helper, 0o755);
      } catch {
        // Windows prebuilds have no spawn-helper.
      }
    })
  );
}

await main();
