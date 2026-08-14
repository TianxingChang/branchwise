import { existsSync } from "node:fs";
import path from "node:path";
import { listPackage } from "@electron/asar";

/**
 * Fails the build if anything the main bundle expects to find on disk did not
 * make it into the package.
 *
 * Worth a hard check because the failure is invisible in testing: an app
 * launched from inside the project tree still resolves these by walking up
 * into the development `node_modules`, so everything works right up until
 * someone installs the app somewhere else. node-pty ships the terminal;
 * @anthropic-ai/claude-agent-sdk ships the agent, and shipped broken once
 * already because only the natives were checked.
 */
interface PackageResult {
  outputPaths: string[];
}

interface Requirement {
  /** Relative to node_modules, as it would be imported. */
  module: string;
  /** A file or directory inside it that proves it is whole, if any. */
  proof?: string;
  what: string;
}

const REQUIRED: Requirement[] = [
  {
    module: path.join("@anthropic-ai", "claude-agent-sdk"),
    proof: "sdk.mjs",
    what: "the agent",
  },
  { module: "node-pty", proof: "prebuilds", what: "the terminal" },
];

export function verifyPackagedDependencies(result: PackageResult): void {
  const missing: string[] = [];

  for (const output of result.outputPaths) {
    const resources = existsSync(path.join(output, "branchwise.app"))
      ? path.join(output, "branchwise.app", "Contents", "Resources")
      : path.join(output, "resources");

    // Inside the archive, existsSync is no answer: asar patches itself into
    // fs for Electron, not for the plain Node running this hook, so a packed
    // module looks absent. The archive has to be listed instead — a lesson
    // this check learned by reporting the agent SDK missing while it sat in
    // app.asar.
    const packed = new Set(
      existsSync(path.join(resources, "app.asar"))
        ? listPackage(path.join(resources, "app.asar"), { isPack: false })
        : []
    );

    for (const requirement of REQUIRED) {
      const unpackedRoots = [
        path.join(resources, "app.asar.unpacked", "node_modules"),
        path.join(resources, "app", "node_modules"),
      ].map((root) => path.join(root, requirement.module));

      const onDisk = unpackedRoots.find((root) => existsSync(root));
      // asar lists with forward slashes and a leading slash, whatever the host.
      const inArchive = `/${path.join("node_modules", requirement.module)}`;

      if (!(onDisk || packed.has(inArchive))) {
        missing.push(
          `${output}: ${requirement.module} was not packaged — ${requirement.what} cannot run`
        );
        continue;
      }

      if (!requirement.proof) {
        continue;
      }

      const proven = onDisk
        ? existsSync(path.join(onDisk, requirement.proof))
        : packed.has(`${inArchive}/${requirement.proof}`);

      if (!proven) {
        missing.push(
          `${output}: ${requirement.module} has no ${requirement.proof}`
        );
      }
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Packaged app is missing dependencies:\n  ${missing.join("\n  ")}`
    );
  }
}
