import { Plus, X } from "lucide-react";
import { useCallback } from "react";
import { conversationsOf, useAgentTabsStore } from "@/stores/agent-tabs-store";
import { cn } from "@/utils/tailwind";

/**
 * The worktree's conversations, beside the panel's own tabs.
 *
 * Underlined text rather than filled chips, and that is the whole point.
 * These sat on a row of their own directly beneath the panel tabs, in the
 * same chip shape and size, which implied a hierarchy that does not exist:
 * "which view of this branch" and "which conversation inside this view" are
 * unrelated axes. Made a different species and put on the same row, they read
 * as a different kind of thing and cost no extra height.
 *
 * Numbered by position, not by id. Ids never repeat, so they climb forever —
 * "Chat 7" beside "Chat 2" reads as a gap in a list rather than as the two
 * conversations that are open.
 */
export default function ConversationTabs({
  worktreePath,
}: {
  worktreePath: string;
}) {
  const conversations = useAgentTabsStore((state) =>
    conversationsOf(state, worktreePath)
  );
  const open = useAgentTabsStore((state) => state.open);

  const handleOpen = useCallback(() => {
    open(worktreePath);
  }, [open, worktreePath]);

  return (
    <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
      {conversations.ids.map((id, at) => (
        <ConversationTab
          at={at}
          canClose={conversations.ids.length > 1}
          id={id}
          isActive={id === conversations.activeId}
          key={id}
          worktreePath={worktreePath}
        />
      ))}
      <button
        aria-label="New conversation"
        className="flex size-5 shrink-0 items-center justify-center rounded text-bw-muted transition-colors duration-150 hover:bg-bw-subtle hover:text-bw-ink"
        onClick={handleOpen}
        title="New conversation"
        type="button"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

function ConversationTab({
  at,
  canClose,
  id,
  isActive,
  worktreePath,
}: {
  at: number;
  canClose: boolean;
  id: string;
  isActive: boolean;
  worktreePath: string;
}) {
  const focus = useAgentTabsStore((state) => state.focus);
  const close = useAgentTabsStore((state) => state.close);

  const handleSelect = useCallback(() => {
    focus(worktreePath, id);
  }, [focus, id, worktreePath]);

  const handleClose = useCallback(() => {
    close(worktreePath, id);
  }, [close, id, worktreePath]);

  return (
    <span
      className={cn(
        "group flex shrink-0 items-center gap-0.5 border-b-2 pr-0.5 pl-1.5 transition-colors duration-150",
        isActive
          ? "border-bw-ink text-bw-ink"
          : "border-transparent text-bw-muted hover:text-bw-ink"
      )}
    >
      <button
        className="py-1 text-[11px] focus-visible:outline-none"
        onClick={handleSelect}
        type="button"
      >
        Chat {at + 1}
      </button>
      {canClose ? (
        <button
          aria-label={`Close chat ${at + 1}`}
          className="flex size-4 items-center justify-center rounded opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-60"
          onClick={handleClose}
          type="button"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      ) : (
        // Holds the tab's width steady whether or not it can be closed, so
        // opening a second conversation does not shift the first sideways.
        <span aria-hidden="true" className="size-4 shrink-0" />
      )}
    </span>
  );
}
