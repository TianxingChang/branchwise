import { useEffect } from "react";
import { projectExists } from "@/actions/project";
import TabBar from "@/components/chrome/tab-bar";
import OpenFolder from "@/components/workspace/open-folder";
import ProjectWorkspace from "@/components/workspace/project-workspace";
import {
  ensureInitialTab,
  type ProjectTab,
  useTabsStore,
} from "@/stores/tabs-store";

export default function AppShell() {
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const pruneMissing = useTabsStore((state) => state.pruneMissing);

  useEffect(() => {
    ensureInitialTab();
  }, []);

  // Restored tabs point at folders that may have been moved or deleted since
  // the last run; drop those rather than showing a workspace that can't save.
  useEffect(() => {
    let active = true;

    const restored = useTabsStore
      .getState()
      .tabs.map((tab) => tab.project?.path)
      .filter((path): path is string => Boolean(path));

    if (restored.length === 0) {
      return;
    }

    Promise.all(
      restored.map(async (path) => ({
        exists: await projectExists(path).catch(() => true),
        path,
      }))
    ).then((results) => {
      if (!active) {
        return;
      }
      pruneMissing(
        results.filter((item) => !item.exists).map((item) => item.path)
      );
    });

    return () => {
      active = false;
    };
  }, [pruneMissing]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bw-canvas">
      <TabBar />
      <main className="min-h-0 flex-1">
        <TabSurface tab={activeTab} />
      </main>
    </div>
  );
}

function TabSurface({ tab }: { tab: ProjectTab | undefined }) {
  if (!tab) {
    return null;
  }

  if (tab.project) {
    return <ProjectWorkspace key={tab.project.path} project={tab.project} />;
  }

  return <OpenFolder key={tab.id} tabId={tab.id} />;
}
