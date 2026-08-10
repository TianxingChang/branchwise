import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Telescope,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachViewState,
  hideView,
  navigateView,
  openView,
  placeView,
  reloadView,
  viewBack,
  viewForward,
} from "@/actions/view";
import { normalizeViewUrl } from "@/lib/view/url";
import { useViewStore } from "@/stores/view-store";
import type { CanvasNode } from "@/types/branch";
import type { ViewState } from "@/types/view";
import { cn } from "@/utils/tailwind";

interface ViewTabProps {
  branchLabel: string;
  node: CanvasNode;
}

export default function ViewTab({ branchLabel, node }: ViewTabProps) {
  if (node.prunable) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="text-[12.5px] text-bw-muted leading-relaxed">
          This worktree's directory is missing, so nothing can be serving from
          it. Prune it from the canvas.
        </p>
      </div>
    );
  }

  return <ViewBrowser branchLabel={branchLabel} worktreePath={node.id} />;
}

function ViewBrowser({
  branchLabel,
  worktreePath,
}: {
  branchLabel: string;
  worktreePath: string;
}) {
  const savedUrl = useViewStore((store) => store.urls[worktreePath] ?? null);
  const setSavedUrl = useViewStore((store) => store.setUrl);

  const [pageState, setPageState] = useState<ViewState | null>(null);
  const [address, setAddress] = useState(savedUrl ?? "");
  const [entryError, setEntryError] = useState<string | null>(null);
  const addressFocused = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  const failure = pageState?.failure ?? null;

  const syncBounds = useCallback(() => {
    const host = viewportRef.current;
    if (!host) {
      return;
    }
    const rect = host.getBoundingClientRect();
    placeView(worktreePath, {
      height: Math.max(0, Math.round(rect.height)),
      width: Math.max(0, Math.round(rect.width)),
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(rect.top)),
    }).catch(() => undefined);
  }, [worktreePath]);

  // The state stream is keyed by worktree and outlives any one page load.
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;

    (async () => {
      try {
        const stream = await attachViewState(worktreePath, controller.signal);
        for await (const event of stream) {
          if (disposed) {
            return;
          }
          setPageState(event);
          if (event.url) {
            // The store follows the page, so a remount resumes exactly where
            // the page ended up rather than where the user first pointed it.
            setSavedUrl(worktreePath, event.url);
            if (!addressFocused.current) {
              setAddress(event.url);
            }
          }
        }
      } catch {
        // The stream ended with the panel; there is nothing left to show.
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [worktreePath, setSavedUrl]);

  // Loading is driven by the saved address alone. Retry and reload force a
  // load explicitly instead of re-running this, so nothing loads twice.
  useEffect(() => {
    if (!savedUrl) {
      return;
    }
    let live = true;
    openView(worktreePath, savedUrl)
      .then(() => {
        if (live) {
          syncBounds();
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [worktreePath, savedUrl, syncBounds]);

  // Placement: the native view floats above the DOM, so this keeps it glued
  // to the viewport card — and parks it off-screen whenever the card is not
  // the thing to show. The page itself is never torn down here: it belongs
  // to the worktree, and switching panel tabs must not reload a running app.
  useEffect(() => {
    if (!savedUrl || failure) {
      hideView(worktreePath).catch(() => undefined);
      return;
    }
    const host = viewportRef.current;
    if (!host) {
      return;
    }
    const observer = new ResizeObserver(syncBounds);
    observer.observe(host);
    window.addEventListener("resize", syncBounds);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      hideView(worktreePath).catch(() => undefined);
    };
  }, [worktreePath, savedUrl, failure, syncBounds]);

  const commitEntry = useCallback(() => {
    const normalized = normalizeViewUrl(address);
    if (!normalized) {
      setEntryError("That doesn't look like an address branchwise can load.");
      return;
    }
    setEntryError(null);
    setAddress(normalized);
    if (normalized === savedUrl) {
      // Same address is a reload wish, and the load effect will not re-run.
      navigateView(worktreePath, normalized).catch(() => undefined);
    } else {
      setSavedUrl(worktreePath, normalized);
    }
  }, [address, savedUrl, setSavedUrl, worktreePath]);

  const handleSubmit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      commitEntry();
    },
    [commitEntry]
  );

  const handleAddressChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setAddress(event.target.value);
    },
    []
  );

  const handleAddressFocus = useCallback(() => {
    addressFocused.current = true;
  }, []);

  const handleAddressBlur = useCallback(() => {
    addressFocused.current = false;
    // Let go without committing: fall back to where the page is.
    setAddress(pageState?.url || savedUrl || "");
  }, [pageState?.url, savedUrl]);

  const handleBack = useCallback(() => {
    viewBack(worktreePath).catch(() => undefined);
  }, [worktreePath]);

  const handleForward = useCallback(() => {
    viewForward(worktreePath).catch(() => undefined);
  }, [worktreePath]);

  const handleReload = useCallback(() => {
    reloadView(worktreePath).catch(() => undefined);
  }, [worktreePath]);

  const handleRetry = useCallback(() => {
    if (savedUrl) {
      navigateView(worktreePath, savedUrl).catch(() => undefined);
    }
  }, [savedUrl, worktreePath]);

  if (!savedUrl) {
    return (
      <form
        className="flex h-full flex-col items-center justify-center gap-2.5 px-8 text-center"
        onSubmit={handleSubmit}
      >
        <Telescope className="text-bw-edge" size={22} strokeWidth={1.5} />
        <p className="text-[13px] text-bw-ink">View</p>
        <p className="max-w-64 text-[12.5px] text-bw-muted leading-relaxed">
          Point this at whatever {branchLabel} is serving — a dev server, a
          preview deploy, anything with an address.
        </p>
        <input
          className="h-7 w-full max-w-64 rounded-lg border border-bw-hairline bg-bw-surface px-2.5 text-center font-mono text-[12px] text-bw-ink outline-none placeholder:text-bw-edge focus:border-bw-edge"
          onChange={handleAddressChange}
          placeholder="localhost:3000"
          value={address}
        />
        <button
          className="rounded-lg border border-bw-hairline bg-bw-surface px-2.5 py-1 text-[12px] text-bw-ink transition-colors hover:border-bw-edge"
          type="submit"
        >
          Open
        </button>
        {entryError ? (
          <p className="text-[11.5px] text-bw-pending">{entryError}</p>
        ) : null}
      </form>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 px-2 py-1.5">
        <ToolbarButton
          disabled={!pageState?.canGoBack}
          label="Back"
          onClick={handleBack}
        >
          <ArrowLeft size={13} />
        </ToolbarButton>
        <ToolbarButton
          disabled={!pageState?.canGoForward}
          label="Forward"
          onClick={handleForward}
        >
          <ArrowRight size={13} />
        </ToolbarButton>
        <ToolbarButton label="Reload" onClick={handleReload}>
          <RotateCw
            className={pageState?.loading ? "animate-spin" : undefined}
            size={13}
          />
        </ToolbarButton>
        <form className="min-w-0 flex-1 pl-1" onSubmit={handleSubmit}>
          <input
            aria-label="Preview address"
            className="h-6 w-full rounded-md border border-bw-hairline bg-bw-canvas px-2 font-mono text-[11px] text-bw-ink outline-none focus:border-bw-edge"
            onBlur={handleAddressBlur}
            onChange={handleAddressChange}
            onFocus={handleAddressFocus}
            value={address}
          />
        </form>
      </div>

      <div className="min-h-0 flex-1 px-2 pb-2">
        {failure ? (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 rounded-[10px] bg-bw-subtle px-8 text-center">
            <Unplug className="text-bw-edge" size={22} strokeWidth={1.5} />
            <p className="text-[13px] text-bw-ink">
              Nothing answered at {savedUrl}
            </p>
            <p className="max-w-64 text-[12.5px] text-bw-muted leading-relaxed">
              {failure}. If {branchLabel}'s dev server is still starting, retry
              once it is up.
            </p>
            <button
              className="rounded-lg border border-bw-hairline bg-bw-surface px-2.5 py-1 text-[12px] text-bw-ink transition-colors hover:border-bw-edge"
              onClick={handleRetry}
              type="button"
            >
              Retry
            </button>
          </div>
        ) : (
          <div
            className="h-full w-full overflow-hidden rounded-[10px] bg-bw-subtle"
            ref={viewportRef}
          />
        )}
      </div>
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors",
        disabled
          ? "text-bw-edge"
          : "text-bw-muted hover:bg-bw-subtle hover:text-bw-ink"
      )}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
