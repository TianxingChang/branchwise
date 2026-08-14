import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { verifyPackagedDependencies } from "./scripts/verify-packaged-natives";

/**
 * The Vite plugin packages only `.vite`, on the assumption that everything is
 * bundled. Anything the main bundle marks external has to ship as real files.
 *
 * Native modules cannot be bundled at all. The agent SDK could be, but is
 * deliberately not: it is loaded by a dynamic import so the main bundle does
 * not pay for it until an agent runs, and inlining it would undo that. Being
 * external and unpackaged is what produced "Cannot find package
 * '@anthropic-ai/claude-agent-sdk'" at the first message in a packaged build.
 */
const PACKAGED_NODE_MODULES = [
  "/node_modules/@anthropic-ai",
  "/node_modules/node-addon-api",
  "/node_modules/node-pty",
];

const shouldPackage = (file: string) =>
  !file ||
  file.startsWith("/.vite") ||
  file === "/node_modules" ||
  PACKAGED_NODE_MODULES.some(
    (prefix) => file === prefix || file.startsWith(`${prefix}/`)
  );

const config: ForgeConfig = {
  hooks: {
    postPackage: (_forgeConfig, result) => {
      verifyPackagedDependencies(result);
      return Promise.resolve();
    },
  },
  makers: [
    new MakerSquirrel({}),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  packagerConfig: {
    asar: {
      // node-pty runs `spawn-helper` as a real executable, which cannot live
      // inside the asar archive.
      unpack: "**/node_modules/node-pty/**",
    },
    // Shared with Dotwise Canvas rather than a second drawing of the same
    // mark: one icns, copied in, so the two apps cannot drift apart in the
    // Dock. The extension is left off — packager picks .icns or .ico per
    // platform, and naming one would break the other.
    icon: "./images/dotwise",
    ignore: (file) => !shouldPackage(file),
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          config: "vite.main.config.mts",
          entry: "src/main.ts",
          target: "main",
        },
        {
          config: "vite.preload.config.mts",
          entry: "src/preload.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          config: "vite.renderer.config.mts",
          name: "main_window",
        },
      ],
    }),

    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  publishers: [
    {
      config: {
        draft: true,
        prerelease: false,
        repository: {
          name: "branchwise",
          owner: "branchwise",
        },
      },
      /*
       * Publish release on GitHub as draft.
       * Remember to manually publish it on GitHub website after verifying everything is correct.
       */
      name: "@electron-forge/publisher-github",
    },
  ],
  rebuildConfig: {},
};

export default config;
