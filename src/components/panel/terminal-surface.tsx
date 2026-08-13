import { FitAddon } from "@xterm/addon-fit";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachTerminal,
  resizeTerminal,
  restartTerminal,
  type TerminalSize,
  type TerminalTarget,
  writeToTerminal,
} from "@/actions/terminal";

/** Matches the surface tokens in global.css so the shell is not a black hole. */
const THEME = {
  background: "#ffffff",
  black: "#1a1a18",
  blue: "#2f6bff",
  brightBlack: "#8c8b84",
  cursor: "#1a1a18",
  cursorAccent: "#ffffff",
  foreground: "#1a1a18",
  green: "#3e9e63",
  red: "#c0392f",
  selectionBackground: "#d7e2ff",
  yellow: "#d9a22e",
};

/**
 * Streams one terminal into an xterm instance until the signal aborts.
 *
 * Lives outside the component so the effect reads as setup rather than as a
 * loop with error handling folded into it.
 */
async function pump(options: {
  isDisposed: () => boolean;
  onExit: (exitCode: number) => void;
  onFailure: (message: string) => void;
  signal: AbortSignal;
  size: TerminalSize;
  target: TerminalTarget;
  term: Xterm;
}): Promise<void> {
  try {
    const stream = await attachTerminal(
      options.target,
      options.size,
      options.signal
    );

    for await (const event of stream) {
      if (options.isDisposed()) {
        return;
      }
      if (event.kind === "data") {
        options.term.write(event.data);
      } else {
        options.onExit(event.exitCode);
      }
    }
  } catch (error) {
    options.onFailure(
      error instanceof Error ? error.message : "The terminal could not start."
    );
  }
}

/**
 * One shell, rendered: an xterm and the stream feeding it, nothing else.
 *
 * Separate from the pane so the pane can own a strip of tabs and mount only
 * whichever of them it is showing. The shells the pane is *not* showing keep
 * running in the main process — this view going away does not end them.
 */
export default function TerminalSurface({
  onSize,
  terminalId,
  worktreePath,
}: TerminalTarget & { onSize: (size: TerminalSize) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const [exited, setExited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Read through a ref so a new callback identity cannot tear down the shell:
  // this effect rebuilds the xterm and re-attaches the stream.
  const onSizeRef = useRef(onSize);
  onSizeRef.current = onSize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const target = { terminalId, worktreePath };

    const term = new Xterm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;

    setExited(null);
    setError(null);

    const controller = new AbortController();
    let disposed = false;

    const measure = () => {
      try {
        fit.fit();
      } catch {
        // The host can be zero-sized for a frame while the panel animates.
      }
      const next = { columns: term.cols, rows: term.rows };
      onSizeRef.current(next);
      return next;
    };

    const initial = measure();

    const typed = term.onData((data) => {
      writeToTerminal(target, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      resizeTerminal(target, measure()).catch(() => undefined);
    });
    observer.observe(host);

    pump({
      isDisposed: () => disposed,
      onExit: setExited,
      onFailure: (message) => {
        if (!(disposed || controller.signal.aborted)) {
          setError(message);
        }
      },
      signal: controller.signal,
      size: initial,
      target,
      term,
    });

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      typed.dispose();
      term.dispose();
      termRef.current = null;
    };
    // The shell itself is not torn down here: it belongs to the worktree, not
    // to this view, so switching tabs, panes or panels must not kill a running
    // process. Closing the terminal is what kills it.
  }, [terminalId, worktreePath]);

  const handleRestart = useCallback(async () => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.clear();
    setExited(null);
    setError(null);
    try {
      await restartTerminal(
        { terminalId, worktreePath },
        { columns: term.cols, rows: term.rows }
      );
    } catch (restartError) {
      setError(
        restartError instanceof Error
          ? restartError.message
          : "The terminal could not restart."
      );
    }
  }, [terminalId, worktreePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-hidden px-2 py-1" ref={hostRef} />

      {error ? (
        <p className="border-bw-hairline border-t px-3 py-1.5 text-[11px] text-bw-pending">
          {error}
        </p>
      ) : null}

      {exited === null ? null : (
        <div className="flex items-center justify-between gap-2 border-bw-hairline border-t px-3 py-1.5">
          <span className="min-w-0 truncate text-[11px] text-bw-muted">
            Shell exited with code {exited}.
          </span>
          <button
            className="flex shrink-0 items-center gap-1 rounded-md border border-bw-hairline bg-bw-surface px-2 py-0.5 text-[11px] text-bw-ink transition-colors hover:border-bw-edge"
            onClick={handleRestart}
            type="button"
          >
            <RotateCcw size={10} />
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
