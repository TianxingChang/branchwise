import { ArrowUp, Plus, Square, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/utils/tailwind";

/**
 * How tall the box may grow before it scrolls, in pixels.
 *
 * A composer that grows without limit eats the transcript it is a reply to.
 */
const MAX_FIELD_HEIGHT = 168;

export interface ComposerAttachment {
  id: string;
  name: string;
  /** An image shows itself; anything else shows its extension. */
  previewUrl?: string;
}

interface ComposerProps {
  attachments?: ComposerAttachment[];
  /** The bottom row's right side, before send — the driver and tier pickers. */
  controls?: React.ReactNode;
  disabled?: boolean;
  onAttach?: () => void;
  onChange: (text: string) => void;
  onInterrupt?: () => void;
  onRemoveAttachment?: (id: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  /** A turn is running: send becomes interrupt. */
  running?: boolean;
  text: string;
}

/**
 * The prompt bar.
 *
 * Stacked rather than laid out in one line: attachments above the text they
 * belong to, then the field, then the controls. The field gets the full width
 * that way — what is being written is the point, and controls either side of
 * it spend the room a long sentence needs on buttons that are the same size
 * whatever is typed.
 */
export default function Composer({
  attachments,
  controls,
  disabled,
  onAttach,
  onChange,
  onInterrupt,
  onRemoveAttachment,
  onSubmit,
  placeholder = "Write a message…",
  running,
  text,
}: ComposerProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  // Measured, not guessed: reset to auto first so the box can shrink again
  // when a draft is deleted, then take the height the content actually needs.
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) {
      return;
    }
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT)}px`;
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const field = event.currentTarget;
      field.style.height = "auto";
      field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT)}px`;
      onChange(field.value);
    },
    [onChange]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter breaks the line.
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      event.preventDefault();
      onSubmit();
    },
    [onSubmit]
  );

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <div
      className={cn(
        "flex flex-col rounded-field border border-bw-hairline bg-bw-surface p-2",
        "shadow-card transition-colors duration-150 focus-within:border-bw-edge"
      )}
    >
      {attachments && attachments.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 pb-2">
          {attachments.map((attachment) => (
            <AttachmentChip
              attachment={attachment}
              key={attachment.id}
              onRemove={onRemoveAttachment}
            />
          ))}
        </div>
      ) : null}

      <textarea
        aria-label="Message the agent"
        className="min-h-[22px] w-full resize-none bg-transparent px-1 py-0.5 text-[13.5px] text-bw-ink leading-[19px] outline-none [overflow-wrap:anywhere] placeholder:text-bw-muted"
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={fieldRef}
        rows={1}
        value={text}
      />

      <div className="flex items-center justify-between gap-2 pt-2">
        <button
          aria-label="Attach a file"
          className="flex size-7 shrink-0 items-center justify-center rounded-full border border-bw-hairline text-bw-muted transition-[background-color,color,transform] duration-150 hover:bg-bw-subtle hover:text-bw-ink active:scale-[0.94] disabled:opacity-40"
          disabled={disabled || !onAttach}
          onClick={onAttach}
          title="Attach a file"
          type="button"
        >
          <Plus size={15} />
        </button>

        <div className="flex min-w-0 items-center gap-1.5">
          {controls}

          {running ? (
            <button
              aria-label="Interrupt the current turn"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-bw-subtle text-bw-ink transition-[background-color,transform] duration-200 hover:bg-bw-edge active:scale-[0.94]"
              onClick={onInterrupt}
              title="Interrupt"
              type="button"
            >
              <Square fill="currentColor" size={9} />
            </button>
          ) : (
            <button
              aria-label="Send"
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full",
                "transition-[background-color,color,transform] duration-200 enabled:active:scale-[0.94]",
                canSend
                  ? "bg-bw-ink text-bw-surface"
                  : "bg-bw-subtle text-bw-muted"
              )}
              disabled={!canSend}
              onClick={onSubmit}
              title="Send"
              type="button"
            >
              <ArrowUp size={15} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One attached file, above the message it belongs to.
 *
 * An image shows itself; anything else shows its extension, which is the part
 * of a filename that still says what the thing is once the name is truncated.
 */
function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment;
  onRemove?: (id: string) => void;
}) {
  const handleRemove = useCallback(() => {
    onRemove?.(attachment.id);
  }, [attachment.id, onRemove]);

  const extension = attachment.name.split(".").pop()?.slice(0, 4) ?? "file";

  return (
    <span className="group relative flex min-w-0 max-w-44 items-center gap-1.5 rounded-control border border-bw-hairline bg-bw-surface py-1 pr-2 pl-1 shadow-btn">
      {attachment.previewUrl ? (
        <img
          alt=""
          className="size-6 shrink-0 rounded-chip object-cover"
          src={attachment.previewUrl}
        />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center rounded-chip bg-bw-subtle font-mono text-[8.5px] text-bw-muted uppercase">
          {extension}
        </span>
      )}
      <span className="min-w-0 truncate text-[12px] text-bw-ink">
        {attachment.name}
      </span>
      {onRemove ? (
        <button
          aria-label={`Remove ${attachment.name}`}
          className="absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full border border-bw-hairline bg-bw-surface text-bw-muted opacity-0 shadow-btn transition-opacity duration-150 hover:text-bw-ink focus-visible:opacity-100 group-hover:opacity-100"
          onClick={handleRemove}
          type="button"
        >
          <X size={9} strokeWidth={2.5} />
        </button>
      ) : null}
    </span>
  );
}
