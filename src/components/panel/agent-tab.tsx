import { ArrowUp, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ConversationItem } from "@/lib/agent/fold";
import { selectSession, useAgentStore } from "@/stores/agent-store";

interface AgentTabProps {
  branchLabel: string;
  nodeId: string;
  projectFolder: string;
}

/**
 * Interim rendering on top of the real store (Task 11): items map to plain
 * rows and there is no config bar, tool/permission cards, or interrupt
 * control yet — Task 12 rebuilds this on the same store shape with the full
 * card set.
 */
export default function AgentTab({ branchLabel, nodeId }: AgentTabProps) {
  const session = useAgentStore((state) => selectSession(state, nodeId));
  const open = useAgentStore((state) => state.open);
  const close = useAgentStore((state) => state.close);
  const sendMessage = useAgentStore((state) => state.sendMessage);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    open(nodeId);
    return () => close(nodeId);
  }, [close, nodeId, open]);

  const { conversation } = session;
  const running = conversation.activeTurnId !== null;

  // items/streamingText are triggers, not references: the effect re-runs to
  // pin the view to the newest content. Removing them silently breaks
  // auto-scroll.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [conversation.items, conversation.streamingText]);

  const submit = useCallback(() => {
    if (draft.trim().length === 0 || running) {
      return;
    }
    sendMessage(nodeId, draft);
    setDraft("");
  }, [draft, nodeId, running, sendMessage]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    []
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [submit]
  );

  const hasContent = conversation.items.length > 0 || running;

  return (
    <div className="flex h-full flex-col">
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        ref={scrollRef}
      >
        {hasContent ? null : <EmptyConversation />}

        {conversation.items.map((item) => (
          <ConversationItemRow item={item} key={item.id} />
        ))}

        {conversation.streamingText ? (
          <AssistantText text={conversation.streamingText} />
        ) : null}

        {running && !conversation.streamingText ? (
          <p className="pl-6 text-[12.5px] text-bw-muted">Thinking…</p>
        ) : null}
      </div>

      <div className="border-bw-hairline border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border border-bw-hairline bg-bw-canvas/60 py-2 pr-2 pl-3 focus-within:border-bw-edge">
          <textarea
            className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[12.5px] text-bw-ink leading-relaxed outline-none placeholder:text-bw-muted"
            disabled={running}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`Ask the agent to work on ${branchLabel}…`}
            rows={1}
            value={draft}
          />
          <button
            aria-label="Send message"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bw-ink text-white transition-opacity disabled:opacity-25"
            disabled={draft.trim().length === 0 || running}
            onClick={submit}
            type="button"
          >
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyConversation() {
  return (
    <div className="flex flex-col gap-1.5 pt-6">
      <p className="text-[13px] text-bw-ink">No work on this branch yet.</p>
      <p className="text-[12.5px] text-bw-muted leading-relaxed">
        Describe what should happen here. Nothing runs until you send the first
        message.
      </p>
    </div>
  );
}

function AssistantText({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <Sparkles className="mt-0.5 shrink-0 text-bw-muted" size={13} />
      <p className="whitespace-pre-wrap text-[12.5px] text-bw-ink leading-relaxed">
        {text}
      </p>
    </div>
  );
}

function ConversationItemRow({ item }: { item: ConversationItem }) {
  if (item.kind === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-xl bg-bw-subtle px-3 py-2 text-[12.5px] text-bw-ink leading-relaxed">
          {item.text}
        </p>
      </div>
    );
  }

  if (item.kind === "assistant") {
    return <AssistantText text={item.text} />;
  }

  if (item.kind === "tool") {
    return (
      <p className="pl-5 text-[12px] text-bw-muted leading-relaxed">
        {item.name} — {item.state}: {item.detail}
      </p>
    );
  }

  if (item.kind === "permission") {
    return (
      <p className="pl-5 text-[12px] text-bw-muted leading-relaxed">
        {item.toolName} wants to run "{item.detail}" — {item.state}
      </p>
    );
  }

  return (
    <p className="text-[12.5px] text-bw-pending leading-relaxed">{item.text}</p>
  );
}
