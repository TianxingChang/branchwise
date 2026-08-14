import { Check } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getAgentConfig } from "@/actions/agent";
import InheritControl, {
  type InheritMode,
} from "@/components/canvas/inherit-control";
import { FIRST_CONVERSATION } from "@/lib/agent/identity";

interface BranchNameFormProps {
  initialValue?: string;
  onCancel: () => void;
  onCommit: (name: string, inherit: InheritMode) => void;
  /**
   * The branch this one comes from, or null when renaming rather than
   * branching — which is what decides whether inheriting is offered at all.
   */
  parentWorktreePath: string | null;
  placeholder: string;
}

/**
 * Naming a branch, in a row rather than on a card.
 *
 * The canvas has its own version shaped like a node, because on a canvas a
 * draft *is* a node. Here it is a row, so this is a row — but both offer the
 * same inherit choice through the same control, so there is one implementation
 * of what a new branch starts with rather than two that can drift.
 */
export default function BranchNameForm({
  initialValue = "",
  onCancel,
  onCommit,
  parentWorktreePath,
  placeholder,
}: BranchNameFormProps) {
  const [value, setValue] = useState(initialValue);
  const [inheritMode, setInheritMode] = useState<InheritMode>("brief");
  const [parentHasConversation, setParentHasConversation] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Read from the actions layer rather than the agent store: the store only
  // holds a worktree's session once AgentTab has mounted for it this run, so
  // after a relaunch the store would say "no conversation" about a branch that
  // has one, and quietly withdraw the offer to inherit it.
  useEffect(() => {
    if (parentWorktreePath === null) {
      return;
    }

    let active = true;
    getAgentConfig({
      conversationId: FIRST_CONVERSATION,
      worktreePath: parentWorktreePath,
    })
      .then((config) => {
        if (active) {
          setParentHasConversation(config.hasConversation);
        }
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [parentWorktreePath]);

  const showInherit = parentWorktreePath !== null && parentHasConversation;

  const commit = useCallback(() => {
    if (value.trim().length > 0) {
      onCommit(value, showInherit ? inheritMode : "none");
    } else {
      onCancel();
    }
  }, [inheritMode, onCancel, onCommit, showInherit, value]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setValue(event.target.value);
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.key === "Enter") {
        commit();
      }
      if (event.key === "Escape") {
        onCancel();
      }
    },
    [commit, onCancel]
  );

  return (
    <div className="flex flex-col gap-1 py-1 pr-2">
      <div className="flex items-center gap-1.5 rounded-md border border-bw-accent/45 bg-bw-surface px-1.5 py-0.5">
        <input
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-bw-ink outline-none placeholder:text-bw-muted"
          onBlur={commit}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={inputRef}
          value={value}
        />
        <button
          aria-label="Confirm branch name"
          className="flex size-4 shrink-0 items-center justify-center rounded text-bw-muted hover:text-bw-accent"
          onClick={commit}
          // Mouse-down would blur the input first, committing before the
          // click lands and making this button look like it did nothing.
          onMouseDown={preventBlur}
          type="button"
        >
          <Check size={11} />
        </button>
      </div>

      {showInherit ? (
        <InheritControl onChange={setInheritMode} value={inheritMode} />
      ) : null}
    </div>
  );
}

function preventBlur(event: React.MouseEvent) {
  event.preventDefault();
}
