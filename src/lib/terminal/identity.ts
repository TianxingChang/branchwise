/**
 * A terminal's session key.
 *
 * The rules are not the terminal's own — a worktree holds several agent
 * conversations for the same reason it holds several shells, and both need a
 * key that splits back into its directory. They live in session-key.ts; this
 * is the terminal's name for them.
 */
export {
  directoryOfKey as worktreeOfKey,
  idOfKey,
  isKeyUnder,
  sessionKey as terminalKey,
} from "@/lib/session-key";
