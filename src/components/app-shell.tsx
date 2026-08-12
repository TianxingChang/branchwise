import { useEffect } from "react";
import { projectExists } from "@/actions/project";
import TabBar from "@/components/chrome/tab-bar";
import OpenFolder from "@/components/workspace/open-folder";
import ProjectWorkspace from "@/components/workspace/project-workspace";
import { useIsMacOS } from "@/hooks/use-platform";
import {
  ensureInitialTab,
  type ProjectTab,
  useTabsStore,
} from "@/stores/tabs-store";

export default function AppShell() {
  const isMacOS = useIsMacOS();
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const pruneMissing = useTabsStore((state) => state.pruneMissing);

  useEffect(() => {
    ensureInitialTab();
  }, []);

  // Only macOS has a blur layer behind the page, so only there may the frame
  // go translucent. The flag rides on the root element because the colours it
  // switches are custom properties, not classes on any one component.
  useEffect(() => {
    if (!isMacOS) {
      return;
    }

    document.documentElement.dataset.vibrancy = "on";

    return () => {
      document.documentElement.removeAttribute("data-vibrancy");
    };
  }, [isMacOS]);

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

  // No top padding: the tab strip is the header band and centres itself in
  // it. Padding above would push the tabs down without matching room below.
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-bw-chrome px-1.5 pb-1.5">
      <TabBar />
      {/* The workspace is a card floating in the frame, the way a browser's
          page sits inside its chrome. `overflow-hidden` is what makes the
          rounding real — the canvas and panel both paint to their own edges. */}
      <main className="min-h-0 flex-1 overflow-hidden rounded-xl border border-bw-frame-edge bg-bw-canvas shadow-[0_1px_3px_rgba(0,0,0,0.06),0_8px_24px_rgba(0,0,0,0.08)]">
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
