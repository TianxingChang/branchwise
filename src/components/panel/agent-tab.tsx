import { ArrowUp, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AgentTaskStatus,
  conversationKey,
  useAgentStore,
} from "@/stores/agent-store";
import type { BranchNode } from "@/types/branch";
import { cn } from "@/utils/tailwind";

const STATUS_STYLE: Record<AgentTaskStatus, string> = {
  done: "bg-bw-done/10 text-bw-done",
  queued: "bg-bw-subtle text-bw-muted",
  running: "bg-bw-running/10 text-bw-running",
};

const STATUS_LABEL: Record<AgentTaskStatus, string> = {
  done: "Done",
  queued: "Queued",
  running: "Running",
};

interface AgentTabProps {
  branch: BranchNode;
  projectPath: string;
}

export default function AgentTab({ branch, projectPath }: AgentTabProps) {
  const key = conversationKey(projectPath, branch.id);
  const items = useAgentStore((state) => state.conversations[key]?.items);
  const thinking = useAgentStore(
    (state) => state.conversations[key]?.thinking ?? false
  );
  const send = useAgentStore((state) => state.send);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);

  const submit = useCallback(() => {
    if (draft.trim().length === 0 || thinking) {
      return;
    }
    send(key, branch.name, draft);
    setDraft("");
  }, [branch.name, draft, key, send, thinking]);

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

  return (
    <div className="flex h-full flex-col">
      <div
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        ref={scrollRef}
      >
        {items && items.length > 0 ? null : <EmptyConversation />}

        {items?.map((item) =>
          item.kind === "message" ? (
            <Message key={item.id} role={item.role} text={item.text} />
          ) : (
            <TaskCard
              agent={item.agent}
              description={item.description}
              key={item.id}
              status={item.status}
            />
          )
        )}

        {thinking ? (
          <p className="pl-6 text-[12.5px] text-bw-muted">Thinking…</p>
        ) : null}
      </div>

      <div className="border-bw-hairline border-t p-3">
        <div className="flex items-end gap-2 rounded-xl border border-bw-hairline bg-bw-canvas/60 py-2 pr-2 pl-3 focus-within:border-bw-edge">
          <textarea
            className="max-h-28 min-h-6 flex-1 resize-none bg-transparent text-[12.5px] text-bw-ink leading-relaxed outline-none placeholder:text-bw-muted"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={`Ask the agent to work on ${branch.name}…`}
            rows={1}
            value={draft}
          />
          <button
            aria-label="Send message"
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bw-ink text-white transition-opacity disabled:opacity-25"
            disabled={draft.trim().length === 0 || thinking}
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

function Message({ role, text }: { role: "assistant" | "user"; text: string }) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-xl bg-bw-subtle px-3 py-2 text-[12.5px] text-bw-ink leading-relaxed">
          {text}
        </p>
      </div>
    );
  }

  return (
    <div className="flex gap-2">
      <Sparkles className="mt-0.5 shrink-0 text-bw-muted" size={13} />
      <p className="text-[12.5px] text-bw-ink leading-relaxed">{text}</p>
    </div>
  );
}

function TaskCard({
  agent,
  description,
  status,
}: {
  agent: string;
  description: string;
  status: AgentTaskStatus;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-bw-hairline bg-bw-canvas/50 px-3 py-2.5">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          status === "done" && "bg-bw-done",
          status === "running" &&
            "animate-pulse bg-bw-running motion-reduce:animate-none",
          status === "queued" && "bg-bw-edge"
        )}
      />
      <span className="shrink-0 text-[12px] text-bw-ink">{agent}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-bw-muted">
        {description}
      </span>
      <span
        className={cn(
          "shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px]",
          STATUS_STYLE[status]
        )}
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}
