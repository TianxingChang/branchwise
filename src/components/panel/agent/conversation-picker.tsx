import { Plus, X } from "lucide-react";
import type React from "react";
import { useCallback } from "react";

interface ConversationPickerProps {
  activeId: string;
  ids: string[];
  onClose: (conversationId: string) => void;
  onOpen: () => void;
  onSelect: (conversationId: string) => void;
}

/**
 * Which conversation the composer is writing into.
 *
 * It used to be a strip of chips above the transcript, directly beneath the
 * panel's own tabs. Two rows of identically shaped chips implied a hierarchy
 * that does not exist — "which view of this branch" and "which conversation
 * inside this view" are unrelated axes — and the rhyme read as repetition.
 *
 * Down here it is next to the pickers that share its scope: the conversation,
 * its backend and its tier are all properties of the thing being written into.
 * Numbered by position rather than by id, because ids never repeat and climb
 * forever; "Chat 7" beside "Chat 2" reads as a gap in a list rather than as
 * the two conversations that are open.
 */
export default function ConversationPicker({
  activeId,
  ids,
  onClose,
  onOpen,
  onSelect,
}: ConversationPickerProps) {
  const handleSelect = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onSelect(event.target.value);
    },
    [onSelect]
  );

  const handleClose = useCallback(() => {
    onClose(activeId);
  }, [activeId, onClose]);

  return (
    <span className="flex min-w-0 items-center gap-0.5">
      <select
        aria-label="Conversation"
        className="min-w-0 rounded-md border border-bw-hairline bg-bw-surface px-1.5 py-1 font-mono text-[11px] text-bw-ink outline-none focus:border-bw-edge"
        onChange={handleSelect}
        value={activeId}
      >
        {ids.map((id, at) => (
          <option key={id} value={id}>
            Chat {at + 1}
          </option>
        ))}
      </select>

      {ids.length > 1 ? (
        <button
          aria-label="Close this conversation"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-bw-muted transition-colors duration-150 hover:bg-bw-subtle hover:text-bw-ink"
          onClick={handleClose}
          title="Close this conversation"
          type="button"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      ) : null}

      <button
        aria-label="New conversation"
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-bw-muted transition-colors duration-150 hover:bg-bw-subtle hover:text-bw-ink"
        onClick={onOpen}
        title="New conversation"
        type="button"
      >
        <Plus size={12} />
      </button>
    </span>
  );
}
