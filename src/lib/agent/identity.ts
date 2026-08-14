import { sessionKey } from "@/lib/session-key";

export {
  directoryOfKey as worktreeOfKey,
  idOfKey as conversationOfKey,
  isKeyUnder,
} from "@/lib/session-key";

/** The conversation a worktree has always had, before it could have more. */
export const FIRST_CONVERSATION = "1";

/**
 * The key naming one conversation in a worktree.
 *
 * The first conversation keeps the bare worktree path as its key, and that is
 * deliberate rather than a shortcut. Everything the agent has already written
 * to disk is filed under it: the transcript, whose filename is a hash of the
 * path; the registry entry holding the driver, tier and the vendor's own
 * session id; and any pending inheritance. Composing a key for conversation
 * one would orphan all of it — every existing branch would open to an empty
 * conversation and a resumed agent session nobody could reach.
 *
 * Conversations after the first have no history to preserve, so they get a
 * composed key and their own files.
 */
export function agentKey(worktreePath: string, conversationId: string): string {
  return conversationId === FIRST_CONVERSATION
    ? worktreePath
    : sessionKey(worktreePath, conversationId);
}
