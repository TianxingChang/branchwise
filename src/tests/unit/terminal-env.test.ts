import { describe, expect, test } from "vitest";
import { shellEnv } from "@/lib/terminal/env";

describe("shellEnv", () => {
  test("drops the variables a package manager injects into its scripts", () => {
    // Launching branchwise with `npm start` leaves these in its own process.
    // Passing them on makes the user's .zshrc believe it is running inside an
    // npm script — nvm prints a warning about npm_config_prefix on every
    // single shell, which is then echoed again by powerlevel10k.
    const env = shellEnv({
      HOME: "/Users/someone",
      INIT_CWD: "/repo",
      npm_command: "run-script",
      npm_config_prefix: "/Users/someone/.hermes/node",
      npm_lifecycle_event: "start",
      npm_package_name: "branchwise",
      TERM_PROGRAM: "Apple_Terminal",
    });

    expect(env).toEqual({
      HOME: "/Users/someone",
      TERM: "xterm-256color",
      TERM_PROGRAM: "Apple_Terminal",
    });
  });

  test("keeps a variable that merely mentions npm", () => {
    // Only the injected prefix is ours to remove; someone's own NPM_TOKEN or
    // PATH entry is theirs.
    const env = shellEnv({
      MY_npm_config: "keep",
      NPM_TOKEN: "keep",
      PATH: "/usr/bin",
    });

    expect(env.NPM_TOKEN).toBe("keep");
    expect(env.MY_npm_config).toBe("keep");
    expect(env.PATH).toBe("/usr/bin");
  });

  test("declares a terminal the shell can draw colour in", () => {
    expect(shellEnv({}).TERM).toBe("xterm-256color");
  });

  test("overrides an inherited TERM rather than trusting it", () => {
    // Electron may be launched from anything, including a dumb terminal.
    expect(shellEnv({ TERM: "dumb" }).TERM).toBe("xterm-256color");
  });

  test("leaves undefined values out rather than passing them as strings", () => {
    expect("MISSING" in shellEnv({ MISSING: undefined })).toBe(false);
  });
});
