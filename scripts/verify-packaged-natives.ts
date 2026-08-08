import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Fails the build if node-pty did not make it into the package.
 *
 * This is worth a hard check because the failure is invisible in testing: an
 * app launched from inside the project tree still resolves `node-pty` by
 * walking up into the development `node_modules`, so the terminal works right
 * up until someone installs the app somewhere else.
 */
interface PackageResult {
  outputPaths: string[];
}

export function verifyPackagedNatives(result: PackageResult): void {
  const missing: string[] = [];

  for (const output of result.outputPaths) {
    const resources = existsSync(path.join(output, "branchwise.app"))
      ? path.join(output, "branchwise.app", "Contents", "Resources")
      : path.join(output, "resources");

    const roots = [
      path.join(resources, "app.asar.unpacked", "node_modules", "node-pty"),
      path.join(resources, "app", "node_modules", "node-pty"),
    ];

    const found = roots.find((root) => existsSync(root));
    if (!found) {
      missing.push(`${output}: node-pty was not packaged`);
      continue;
    }

    const prebuilds = path.join(found, "prebuilds");
    if (!existsSync(prebuilds)) {
      missing.push(`${found}: node-pty has no prebuilds directory`);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Packaged app is missing native dependencies:\n  ${missing.join("\n  ")}`
    );
  }
}
