import { ipc } from "@/ipc/manager";
import type { GraphDoc } from "@/types/branch";

export interface ProjectRef {
  name: string;
  path: string;
}

export function pickProjectFolder(): Promise<ProjectRef | null> {
  return ipc.client.project.pickProjectFolder();
}

export function loadGraph(path: string): Promise<GraphDoc | null> {
  return ipc.client.project.loadGraph({ path });
}

export function saveGraph(path: string, doc: GraphDoc): Promise<boolean> {
  return ipc.client.project.saveGraph({ doc, path });
}

export function projectExists(path: string): Promise<boolean> {
  return ipc.client.project.projectExists({ path });
}
