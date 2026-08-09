import {
  DEFAULT_PANEL_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_PANEL_WIDTH,
} from "@/lib/branch/constants";
import type { GraphDoc } from "@/types/branch";
import { GRAPH_DOC_VERSION, graphDocSchema } from "@/types/branch";

export const GRAPH_DIR = ".branchwise";
export const GRAPH_FILE = "graph.json";

function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_PANEL_WIDTH;
  }
  return Math.min(
    MAX_PANEL_WIDTH,
    Math.max(MIN_PANEL_WIDTH, Math.round(width))
  );
}

export function createSeedDoc(): GraphDoc {
  return {
    branches: {},
    panel: {
      collapsed: false,
      posture: "peek",
      tab: "agent",
      width: DEFAULT_PANEL_WIDTH,
    },
    selectedWorktree: null,
    version: GRAPH_DOC_VERSION,
  };
}

/**
 * Validates a doc read from disk. Returns null when the payload is unusable —
 * including v1 documents, whose node list described branches that never
 * existed in git and cannot be migrated into anything meaningful.
 */
export function parseGraphDoc(raw: unknown): GraphDoc | null {
  const parsed = graphDocSchema.safeParse(migrateLegacyTab(raw));
  if (!parsed.success) {
    return null;
  }

  return {
    ...parsed.data,
    panel: {
      ...parsed.data.panel,
      width: clampPanelWidth(parsed.data.panel.width),
    },
  };
}

export function serializeGraphDoc(doc: GraphDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * The View placeholder became the Artifact tab. A doc that persisted
 * panel.tab "view" must land on "artifact" rather than fail validation —
 * rejecting it would throw away every branch annotation in the project.
 */
function migrateLegacyTab(raw: unknown): unknown {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "panel" in raw &&
    typeof raw.panel === "object" &&
    raw.panel !== null &&
    "tab" in raw.panel &&
    raw.panel.tab === "view"
  ) {
    return { ...raw, panel: { ...raw.panel, tab: "artifact" } };
  }
  return raw;
}
