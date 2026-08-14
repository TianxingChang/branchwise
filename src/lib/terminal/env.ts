/**
 * Variables a package manager writes into the processes it launches.
 *
 * `npm start` sets a whole `npm_config_*` block plus `npm_lifecycle_*`,
 * `npm_package_*` and `INIT_CWD`, and Electron inherits them. Handing them to
 * a user's shell makes their dotfiles believe they are running inside an npm
 * script: nvm greets every new terminal with a warning that
 * `npm_config_prefix` is set, and powerlevel10k then reports that warning as
 * stray output during initialisation.
 *
 * Matched on the exact prefix, lower-case, so someone's own `NPM_TOKEN` or a
 * variable that merely contains "npm" is left alone.
 */
const INJECTED_PREFIXES = ["npm_", "yarn_", "pnpm_"];
const INJECTED_NAMES = new Set(["INIT_CWD"]);

function isInjected(name: string): boolean {
  return (
    INJECTED_NAMES.has(name) ||
    INJECTED_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/**
 * The environment a shell should start with.
 *
 * Everything the app inherited, less whatever the launcher injected, plus a
 * TERM the shell can draw colour in. TERM is set rather than passed through:
 * branchwise can be started from a dumb terminal or from the Finder with no
 * TERM at all, and the pty is a real xterm either way.
 */
export function shellEnv(
  source: Record<string, string | undefined>
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && !isInjected(name)) {
      env[name] = value;
    }
  }

  env.TERM = "xterm-256color";
  return env;
}
