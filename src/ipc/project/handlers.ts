import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { os } from "@orpc/server";
import { dialog } from "electron";
import {
  GRAPH_DIR,
  GRAPH_FILE,
  parseGraphDoc,
  serializeGraphDoc,
} from "@/lib/branch/doc";
import type { GraphDoc } from "@/types/branch";
import { ipcContext } from "../context";
import { projectPathInputSchema, saveGraphInputSchema } from "./schemas";

export interface ProjectRef {
  name: string;
  path: string;
}

function toProjectRef(folder: string): ProjectRef {
  return { name: path.basename(folder) || folder, path: folder };
}

function graphPathFor(folder: string): string {
  return path.join(folder, GRAPH_DIR, GRAPH_FILE);
}

/** Opens the native folder picker. Returns null when the user cancels. */
export const pickProjectFolder = os
  .use(ipcContext.mainWindowContext)
  .handler(async ({ context }): Promise<ProjectRef | null> => {
    const result = await dialog.showOpenDialog(context.window, {
      buttonLabel: "Open",
      properties: ["openDirectory", "createDirectory"],
      title: "Open project folder",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return toProjectRef(result.filePaths[0]);
  });

/** Returns null when the folder has no graph yet, or the file is unreadable. */
export const loadGraph = os
  .input(projectPathInputSchema)
  .handler(async ({ input }): Promise<GraphDoc | null> => {
    try {
      const contents = await readFile(graphPathFor(input.path), "utf8");
      return parseGraphDoc(JSON.parse(contents));
    } catch {
      return null;
    }
  });

export const saveGraph = os
  .input(saveGraphInputSchema)
  .handler(async ({ input }): Promise<boolean> => {
    try {
      await mkdir(path.join(input.path, GRAPH_DIR), { recursive: true });
      await writeFile(
        graphPathFor(input.path),
        serializeGraphDoc(input.doc),
        "utf8"
      );
      return true;
    } catch (error) {
      console.error("Failed to save graph", error);
      return false;
    }
  });

/** Used on startup to drop restored tabs whose folder has since moved. */
export const projectExists = os
  .input(projectPathInputSchema)
  .handler(async ({ input }): Promise<boolean> => {
    try {
      const stats = await stat(input.path);
      return stats.isDirectory();
    } catch {
      return false;
    }
  });
