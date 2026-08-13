import { ArrowUp, AtSign, Square } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/utils/tailwind";

/**
 * How tall the box may grow before it scrolls, in pixels.
 *
 * A composer that grows without limit eats the transcript it is a reply to.
 */
const MAX_FIELD_HEIGHT = 168;

interface ComposerProps {
  /** Rendered between the model picker and send — driver, tier, and so on. */
  controls?: React.ReactNode;
  disabled?: boolean;
  onChange: (text: string) => void;
  onInterrupt?: () => void;
  onSubmit: () => void;
  placeholder?: string;
  /** A turn is running: send becomes interrupt. */
  running?: boolean;
  text: string;
}

/**
 * The prompt bar.
 *
 * Laid out as a grid rather than a flex row, after Beautiful UI: the field is
 * the only column that flexes, and every control keeps its own column, so a
 * long draft cannot squeeze the send button and an empty one cannot let the
 * controls drift into the middle. `items-end` keeps them on the last line as
 * the field grows, which is where the eye expects them once the text wraps.
 */
export default function Composer({
  controls,
  disabled,
  onChange,
  onInterrupt,
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
      // Enter sends, Shift+Enter breaks the line. The modifier combinations
      // send too, so the habit from every other composer does not misfire.
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
        "relative isolate flex flex-col gap-1.5 overflow-hidden rounded-field",
        "border border-bw-hairline bg-bw-surface p-1.5 shadow-card",
        "transition-colors duration-150 focus-within:border-bw-edge"
      )}
    >
      <div className="grid grid-cols-[28px_minmax(0,1fr)_auto_28px] items-end gap-x-1 gap-y-1.5">
        <button
          aria-label="Mention a file or branch"
          className="col-start-1 row-start-1 flex size-7 shrink-0 items-center justify-center rounded-control text-bw-muted transition-[background-color,color,transform] duration-150 hover:bg-bw-subtle hover:text-bw-ink active:scale-[0.94]"
          disabled={disabled}
          title="Mention a file or branch"
          type="button"
        >
          <AtSign size={14} />
        </button>

        <textarea
          aria-label="Message the agent"
          className="col-start-2 row-start-1 min-h-7 w-full min-w-0 resize-none bg-transparent px-1 py-[5px] text-[13px] text-bw-ink leading-[18px] outline-none [overflow-wrap:anywhere] placeholder:text-bw-muted"
          disabled={disabled}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          ref={fieldRef}
          rows={1}
          value={text}
        />

        <div className="col-start-3 row-start-1 flex items-center gap-1">
          {controls}
        </div>

        {running ? (
          <button
            aria-label="Interrupt the current turn"
            className="col-start-4 row-start-1 flex size-7 shrink-0 items-center justify-center rounded-control bg-bw-subtle text-bw-ink transition-[background-color,transform] duration-200 hover:bg-bw-edge active:scale-[0.94]"
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
              "col-start-4 row-start-1 flex size-7 shrink-0 items-center justify-center rounded-control",
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
            <ArrowUp size={14} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
