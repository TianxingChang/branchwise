import { Plus, X } from "lucide-react";
import { useCallback } from "react";
import { tabStripLeftInset, WINDOW_CHROME } from "@/constants";
import { useIsMacOS } from "@/hooks/use-platform";
import { type ProjectTab, useTabsStore } from "@/stores/tabs-store";
import { cn } from "@/utils/tailwind";

const MACOS_TRAFFIC_LIGHT_INSET = tabStripLeftInset();

export default function TabBar() {
  const isMacOS = useIsMacOS();
  const tabs = useTabsStore((state) => state.tabs);
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const openTab = useTabsStore((state) => state.openTab);

  const handleNewTab = useCallback(() => {
    openTab();
  }, [openTab]);

  return (
    <div
      className="draglayer flex shrink-0 items-center gap-1 pr-1"
      style={{
        height: WINDOW_CHROME.HEADER_HEIGHT,
        paddingLeft: isMacOS ? MACOS_TRAFFIC_LIGHT_INSET : 12,
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {tabs.map((tab) => (
          <TabItem isActive={tab.id === activeTabId} key={tab.id} tab={tab} />
        ))}
        <button
          aria-label="New tab"
          className="no-drag flex size-6 shrink-0 items-center justify-center rounded-md text-bw-muted transition-colors hover:bg-bw-tab-hover hover:text-bw-ink focus-visible:outline-2 focus-visible:outline-bw-accent"
          onClick={handleNewTab}
          title="New tab"
          type="button"
        >
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function TabItem({ isActive, tab }: { isActive: boolean; tab: ProjectTab }) {
  const setActiveTab = useTabsStore((state) => state.setActiveTab);
  const closeTab = useTabsStore((state) => state.closeTab);

  const label = tab.project ? tab.project.name : "New tab";

  const handleSelect = useCallback(() => {
    setActiveTab(tab.id);
  }, [setActiveTab, tab.id]);

  const handleClose = useCallback(() => {
    closeTab(tab.id);
  }, [closeTab, tab.id]);

  return (
    <div
      className={cn(
        "no-drag group flex h-7 min-w-0 max-w-52 shrink-0 items-center gap-1.5 rounded-lg border pr-1 pl-2.5 transition-colors",
        // Opaque while active so it reads as the page's own card rather than
        // another pane of the glass; the inactive ones stay part of the frame.
        isActive
          ? "border-bw-frame-edge bg-bw-surface shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
          : "border-transparent hover:bg-bw-tab-hover"
      )}
    >
      <button
        className="min-w-0 flex-1 truncate text-left text-[12px] focus-visible:outline-none"
        onClick={handleSelect}
        title={tab.project?.path}
        type="button"
      >
        <span className={isActive ? "text-bw-ink" : "text-bw-muted"}>
          {label}
        </span>
      </button>
      <button
        aria-label={`Close ${label}`}
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded text-bw-muted transition-opacity hover:bg-bw-subtle hover:text-bw-ink",
          isActive ? "opacity-60" : "opacity-0 group-hover:opacity-60"
        )}
        onClick={handleClose}
        type="button"
      >
        <X size={11} strokeWidth={2.5} />
      </button>
    </div>
  );
}
