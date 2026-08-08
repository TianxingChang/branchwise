import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ProjectRef } from "@/actions/project";

export interface ProjectTab {
  id: string;
  /** Null until the user picks a folder — that is the "new tab" empty state. */
  project: ProjectRef | null;
}

interface TabsState {
  activeTabId: string | null;
  attachProject: (tabId: string, project: ProjectRef) => void;
  closeTab: (tabId: string) => void;
  openTab: () => string;
  pruneMissing: (missingPaths: string[]) => void;
  setActiveTab: (tabId: string) => void;
  tabs: ProjectTab[];
}

function createTabId(): string {
  return `tab_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36)}`;
}

function emptyTab(): ProjectTab {
  return { id: createTabId(), project: null };
}

export const useTabsStore = create<TabsState>()(
  persist(
    (set, get) => ({
      activeTabId: null,
      attachProject: (tabId, project) => {
        const existing = get().tabs.find(
          (tab) => tab.project?.path === project.path && tab.id !== tabId
        );

        // Opening a folder that is already open focuses it instead of
        // duplicating the workspace — two tabs writing one graph.json would
        // fight over the file.
        if (existing) {
          set((state) => ({
            activeTabId: existing.id,
            tabs:
              get().tabs.find((tab) => tab.id === tabId)?.project === null
                ? state.tabs.filter((tab) => tab.id !== tabId)
                : state.tabs,
          }));
          return;
        }

        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, project } : tab
          ),
        }));
      },
      closeTab: (tabId) => {
        set((state) => {
          const index = state.tabs.findIndex((tab) => tab.id === tabId);
          if (index === -1) {
            return state;
          }

          const tabs = state.tabs.filter((tab) => tab.id !== tabId);
          if (tabs.length === 0) {
            const fresh = emptyTab();
            return { activeTabId: fresh.id, tabs: [fresh] };
          }

          const activeTabId =
            state.activeTabId === tabId
              ? tabs[Math.min(index, tabs.length - 1)].id
              : state.activeTabId;

          return { activeTabId, tabs };
        });
      },
      openTab: () => {
        const tab = emptyTab();
        set((state) => ({ activeTabId: tab.id, tabs: [...state.tabs, tab] }));
        return tab.id;
      },
      pruneMissing: (missingPaths) => {
        if (missingPaths.length === 0) {
          return;
        }
        const missing = new Set(missingPaths);
        set((state) => {
          const tabs = state.tabs.filter(
            (tab) => !(tab.project && missing.has(tab.project.path))
          );
          if (tabs.length === 0) {
            const fresh = emptyTab();
            return { activeTabId: fresh.id, tabs: [fresh] };
          }
          const activeTabId = tabs.some((tab) => tab.id === state.activeTabId)
            ? state.activeTabId
            : tabs[0].id;
          return { activeTabId, tabs };
        });
      },
      setActiveTab: (tabId) => set({ activeTabId: tabId }),
      tabs: [],
    }),
    {
      name: "branchwise.tabs",
      onRehydrateStorage: () => (state) => {
        // A window with no tabs has no affordance to create one, so guarantee
        // there is always exactly one selected tab after restore.
        if (!state) {
          return;
        }
        if (state.tabs.length === 0) {
          const fresh = emptyTab();
          state.tabs = [fresh];
          state.activeTabId = fresh.id;
          return;
        }
        if (!state.tabs.some((tab) => tab.id === state.activeTabId)) {
          state.activeTabId = state.tabs[0].id;
        }
      },
      partialize: (state) => ({
        activeTabId: state.activeTabId,
        tabs: state.tabs,
      }),
      storage: createJSONStorage(() => localStorage),
    }
  )
);

/** Guarantees the store has a usable tab even on a first run with no storage. */
export function ensureInitialTab(): void {
  const { openTab, tabs } = useTabsStore.getState();
  if (tabs.length === 0) {
    openTab();
  }
}
