import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface ViewUrlsState {
  setUrl: (worktreePath: string, url: string) => void;
  /** Worktree path → the address its View tab last showed. */
  urls: Record<string, string>;
}

/**
 * Which address each worktree previews. Kept in localStorage rather than in
 * the project's graph.json: dev-server ports are a per-machine fact, the same
 * argument that keeps panel width out of the shared annotation file.
 */
export const useViewStore = create<ViewUrlsState>()(
  persist(
    (set) => ({
      setUrl: (worktreePath, url) =>
        set((state) =>
          state.urls[worktreePath] === url
            ? state
            : { urls: { ...state.urls, [worktreePath]: url } }
        ),
      urls: {},
    }),
    {
      name: "branchwise.view-urls",
      storage: createJSONStorage(() => localStorage),
    }
  )
);
