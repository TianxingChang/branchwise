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
  writeToTerminal,
} from "@/actions/terminal";
import type { CanvasNode } from "@/types/branch";

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

interface TerminalTabProps {
  node: CanvasNode;
}

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
  term: Xterm;
  worktreePath: string;
}): Promise<void> {
  try {
    const stream = await attachTerminal(
      options.worktreePath,
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

export default function TerminalTab({ node }: TerminalTabProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exited, setExited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const worktreePath = node.id;
  const missing = node.prunable;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || missing) {
      return;
    }

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
    fitRef.current = fit;

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
      return { columns: term.cols, rows: term.rows };
    };

    const size = measure();

    const typed = term.onData((data) => {
      writeToTerminal(worktreePath, data).catch(() => undefined);
    });

    const observer = new ResizeObserver(() => {
      const next = measure();
      resizeTerminal(worktreePath, next).catch(() => undefined);
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
      size,
      term,
      worktreePath,
    });

    return () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      typed.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // The shell itself is not torn down here: it belongs to the worktree, not
    // to this view, so switching panel tabs must not kill a running process.
  }, [missing, worktreePath]);

  const handleRestart = useCallback(async () => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    term.clear();
    setExited(null);
    setError(null);
    try {
      await restartTerminal(worktreePath, {
        columns: term.cols,
        rows: term.rows,
      });
    } catch (restartError) {
      setError(
        restartError instanceof Error
          ? restartError.message
          : "The terminal could not restart."
      );
    }
  }, [worktreePath]);

  if (missing) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="text-[12.5px] text-bw-muted leading-relaxed">
          This worktree's directory is missing, so there is nowhere to open a
          shell. Prune it from the canvas.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-hidden px-3 py-2" ref={hostRef} />

      {error ? (
        <p className="border-bw-hairline border-t px-4 py-2 text-[12px] text-bw-pending">
          {error}
        </p>
      ) : null}

      {exited === null ? null : (
        <div className="flex items-center justify-between border-bw-hairline border-t px-4 py-2">
          <span className="text-[12px] text-bw-muted">
            Shell exited with code {exited}.
          </span>
          <button
            className="flex items-center gap-1.5 rounded-lg border border-bw-hairline bg-bw-surface px-2.5 py-1 text-[12px] text-bw-ink transition-colors hover:border-bw-edge"
            onClick={handleRestart}
            type="button"
          >
            <RotateCcw size={12} />
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
