import { FolderOpen } from "lucide-react";
import { useState } from "react";
import { pickProjectFolder } from "@/actions/project";
import { useTabsStore } from "@/stores/tabs-store";

export default function OpenFolder({ tabId }: { tabId: string }) {
  const attachProject = useTabsStore((state) => state.attachProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const project = await pickProjectFolder();
      if (project) {
        attachProject(tabId, project);
      }
    } catch {
      setError("Could not open that folder. Pick another one.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 bg-bw-canvas">
      <div className="flex flex-col items-center gap-1.5">
        <h1 className="font-mono text-[15px] text-bw-ink tracking-tight">
          branchwise
        </h1>
        <p className="max-w-72 text-center text-[12.5px] text-bw-muted leading-relaxed">
          Open a project folder to map its branches. Each tab holds one project.
        </p>
      </div>

      <button
        className="flex items-center gap-2 rounded-xl border border-bw-hairline bg-bw-surface px-3.5 py-2 text-[12.5px] text-bw-ink shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors hover:border-bw-edge disabled:opacity-50"
        disabled={busy}
        onClick={open}
        type="button"
      >
        <FolderOpen size={14} strokeWidth={1.75} />
        {busy ? "Choosing…" : "Open folder"}
      </button>

      {error ? <p className="text-[12px] text-bw-muted">{error}</p> : null}
    </div>
  );
}
