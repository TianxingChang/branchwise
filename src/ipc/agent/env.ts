const STRIPPED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
];

/**
 * The inherited environment minus git redirection. A GIT_DIR leaking in from
 * whatever spawned branchwise would make every agent operate on the wrong
 * repository regardless of cwd — the A2 correctness bug in env form. Shared
 * by every driver's spawn (claude, codex): stripping it in one place means
 * no adapter can forget it.
 */
export function sanitizedEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of STRIPPED_ENV) {
    delete clean[key];
  }
  return clean;
}
