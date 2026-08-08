import { useCallback, useEffect, useState } from "react";
import { worktreeStatus } from "@/actions/repo";
import type { CanvasNode, WorktreeStatus } from "@/types/branch";
import { branchLabel } from "./branch-node";

export interface DeleteChoice {
  deleteBranch: boolean;
  force: boolean;
}

interface DeleteDialogProps {
  childCount: number;
  node: CanvasNode;
  onCancel: () => void;
  onConfirm: (choice: DeleteChoice) => void;
  parentBranch: string | null;
  projectFolder: string;
}

export default function DeleteDialog({
  childCount,
  node,
  onCancel,
  onConfirm,
  parentBranch,
  projectFolder,
}: DeleteDialogProps) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null);
  const [alsoDeleteBranch, setAlsoDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);

  // The defaults depend on facts only git can answer, so the checkbox starts
  // unticked and is corrected once the status arrives.
  useEffect(() => {
    let active = true;

    worktreeStatus({
      branch: node.branch,
      parentBranch,
      path: projectFolder,
      worktreePath: node.id,
    })
      .then((result) => {
        if (!active) {
          return;
        }
        setStatus(result);
        setAlsoDeleteBranch(result.merged && node.branch !== null);
      })
      .catch(() => {
        if (active) {
          setStatus({ ahead: 0, behind: 0, dirtyCount: 0, merged: false });
        }
      });

    return () => {
      active = false;
    };
  }, [node.branch, node.id, parentBranch, projectFolder]);

  const handleToggle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setAlsoDeleteBranch(event.target.checked);
    },
    []
  );

  const handleConfirm = useCallback(() => {
    setBusy(true);
    onConfirm({
      deleteBranch: alsoDeleteBranch,
      force: (status?.dirtyCount ?? 0) > 0,
    });
  }, [alsoDeleteBranch, onConfirm, status]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape") {
        onCancel();
      }
    },
    [onCancel]
  );

  const label = branchLabel(node);

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-bw-canvas/70 backdrop-blur-[2px]">
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape-to-dismiss belongs on the dialog; Cancel duplicates it for pointer users */}
      <div
        aria-labelledby="delete-dialog-title"
        aria-modal="true"
        className="w-[400px] rounded-2xl border border-bw-hairline bg-bw-surface p-5 shadow-[0_8px_32px_rgba(0,0,0,0.12)]"
        onKeyDown={handleKeyDown}
        role="dialog"
      >
        <h2
          className="font-mono text-[13px] text-bw-ink tracking-tight"
          id="delete-dialog-title"
        >
          Remove {label}
        </h2>

        <dl className="mt-3.5 flex flex-col gap-1.5 text-[12px]">
          <Row label="Worktree" value={node.id} />
          <Row
            label="Uncommitted"
            value={
              status === null
                ? "checking…"
                : `${status.dirtyCount} ${status.dirtyCount === 1 ? "change" : "changes"}`
            }
          />
          <Row
            label="Merged into parent"
            value={(() => {
              if (status === null) {
                return "checking…";
              }
              if (!(node.branch && parentBranch)) {
                return "no parent branch to compare";
              }
              return status.merged ? `yes, into ${parentBranch}` : "not yet";
            })()}
          />
          {childCount > 0 ? (
            <Row
              label="Children"
              value={`${childCount} — they move up to the parent`}
            />
          ) : null}
        </dl>

        {node.branch ? (
          <label className="mt-4 flex items-start gap-2 text-[12.5px] text-bw-ink">
            <input
              checked={alsoDeleteBranch}
              className="mt-0.5 accent-bw-accent"
              onChange={handleToggle}
              type="checkbox"
            />
            <span>
              Also delete the branch{" "}
              <span className="font-mono">{node.branch}</span>
              {status && !status.merged ? (
                <span className="block text-bw-pending">
                  Not merged into its parent — those commits would be lost.
                </span>
              ) : null}
            </span>
          </label>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-[12.5px] text-bw-muted transition-colors hover:text-bw-ink"
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-bw-ink px-3 py-1.5 text-[12.5px] text-white transition-opacity disabled:opacity-40"
            disabled={busy || status === null}
            onClick={handleConfirm}
            type="button"
          >
            {busy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-36 shrink-0 text-bw-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-[11px] text-bw-ink">
        {value}
      </dd>
    </div>
  );
}
