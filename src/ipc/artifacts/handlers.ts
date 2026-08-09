import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { os } from "@orpc/server";
import {
  artifactFileName,
  parseArtifactFileName,
  uniqueArtifactName,
} from "@/lib/artifacts/naming";
import { GRAPH_DIR } from "@/lib/branch/doc";
import type { ArtifactKind, ArtifactMeta } from "@/types/artifacts";
import {
  artifactRefInputSchema,
  createArtifactInputSchema,
  listArtifactsInputSchema,
  renameArtifactInputSchema,
  writeArtifactInputSchema,
} from "./schemas";

export const ARTIFACTS_DIR = "artifacts";

/** What a freshly created artifact contains. An empty canvas is an empty
 * file — the renderer treats "no snapshot yet" as a blank canvas, so the
 * main process never needs to know what a tldraw document looks like. */
const SEED_CONTENT: Record<ArtifactKind, string> = {
  canvas: "",
  note: "",
};

const CREATE_BASE_NAMES: Record<ArtifactKind, string> = {
  canvas: "Canvas",
  note: "Note",
};

/** How many "Note 2", "Note 3", … candidates create will race for before
 * giving up. Only reachable if another writer keeps taking each candidate
 * between the scan and the open. */
const CREATE_ATTEMPTS = 20;

function shelfDirFor(folder: string): string {
  return path.join(folder, GRAPH_DIR, ARTIFACTS_DIR);
}

function artifactPathFor(
  folder: string,
  kind: ArtifactKind,
  name: string
): string {
  // `name` passed the schema, so it is a single plain segment — the join
  // cannot leave the shelf directory.
  return path.join(shelfDirFor(folder), artifactFileName(kind, name));
}

async function readShelf(folder: string): Promise<ArtifactMeta[]> {
  let fileNames: string[];
  try {
    fileNames = await readdir(shelfDirFor(folder));
  } catch {
    // No shelf directory yet — an empty shelf, not an error.
    return [];
  }

  const metas = await Promise.all(
    fileNames.map(async (fileName): Promise<ArtifactMeta | null> => {
      const parsed = parseArtifactFileName(fileName);
      if (!parsed) {
        return null;
      }
      try {
        const stats = await stat(path.join(shelfDirFor(folder), fileName));
        if (!stats.isFile()) {
          return null;
        }
        return { ...parsed, updatedAt: Math.round(stats.mtimeMs) };
      } catch {
        // Deleted between readdir and stat; the next list will agree.
        return null;
      }
    })
  );

  return metas
    .filter((meta): meta is ArtifactMeta => meta !== null)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        }) || left.kind.localeCompare(right.kind)
    );
}

/** Lists the shelf. A missing directory is an empty shelf, never an error. */
export const list = os
  .input(listArtifactsInputSchema)
  .handler(({ input }): Promise<ArtifactMeta[]> => readShelf(input.path));

/**
 * Creates a fresh artifact under a free Finder-style name and returns it.
 * Returns null only when the shelf directory cannot be created or every
 * candidate name is somehow taken.
 */
export const create = os
  .input(createArtifactInputSchema)
  .handler(async ({ input }): Promise<ArtifactMeta | null> => {
    try {
      await mkdir(shelfDirFor(input.path), { recursive: true });
    } catch (error) {
      console.error("Failed to create the artifact shelf", error);
      return null;
    }

    const taken = new Set(
      (await readShelf(input.path))
        .filter((meta) => meta.kind === input.kind)
        .map((meta) => meta.name)
    );

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      const name = uniqueArtifactName(taken, CREATE_BASE_NAMES[input.kind]);
      const filePath = artifactPathFor(input.path, input.kind, name);
      try {
        // "wx" refuses to overwrite: if another window created this name
        // between the scan and now, take the next number instead.
        // biome-ignore lint/performance/noAwaitInLoops: each attempt must observe the previous one's collision — this loop is a retry, not a batch
        await writeFile(filePath, SEED_CONTENT[input.kind], {
          encoding: "utf8",
          flag: "wx",
        });
        const stats = await stat(filePath);
        return {
          kind: input.kind,
          name,
          updatedAt: Math.round(stats.mtimeMs),
        };
      } catch {
        taken.add(name);
      }
    }

    console.error("Failed to create an artifact: no free name found");
    return null;
  });

/** Returns the artifact's text, or null when it does not exist. */
export const read = os
  .input(artifactRefInputSchema)
  .handler(async ({ input }): Promise<{ content: string } | null> => {
    try {
      const content = await readFile(
        artifactPathFor(input.path, input.kind, input.name),
        "utf8"
      );
      return { content };
    } catch {
      return null;
    }
  });

/** Writes the artifact, creating the shelf on the way if needed. */
export const write = os
  .input(writeArtifactInputSchema)
  .handler(async ({ input }): Promise<boolean> => {
    try {
      await mkdir(shelfDirFor(input.path), { recursive: true });
      await writeFile(
        artifactPathFor(input.path, input.kind, input.name),
        input.content,
        "utf8"
      );
      return true;
    } catch (error) {
      console.error("Failed to write artifact", error);
      return false;
    }
  });

/**
 * Renames an artifact and returns its new identity. The requested name is
 * suffixed Finder-style when taken, so the caller must adopt the returned
 * name rather than the one it asked for. Null when the source is gone.
 */
export const renameArtifact = os
  .input(renameArtifactInputSchema)
  .handler(async ({ input }): Promise<ArtifactMeta | null> => {
    const from = artifactPathFor(input.path, input.kind, input.name);

    if (input.to === input.name) {
      try {
        const stats = await stat(from);
        return {
          kind: input.kind,
          name: input.name,
          updatedAt: Math.round(stats.mtimeMs),
        };
      } catch {
        return null;
      }
    }

    const taken = new Set(
      (await readShelf(input.path))
        .filter((meta) => meta.kind === input.kind)
        .map((meta) => meta.name)
    );
    // Renaming "a" to "A" must not collide with itself.
    taken.delete(input.name);

    const target = uniqueArtifactName(taken, input.to);
    try {
      await rename(from, artifactPathFor(input.path, input.kind, target));
      const stats = await stat(artifactPathFor(input.path, input.kind, target));
      return {
        kind: input.kind,
        name: target,
        updatedAt: Math.round(stats.mtimeMs),
      };
    } catch (error) {
      console.error("Failed to rename artifact", error);
      return null;
    }
  });

/** Deletes the artifact's file. True when it is gone afterwards. */
export const remove = os
  .input(artifactRefInputSchema)
  .handler(async ({ input }): Promise<boolean> => {
    try {
      await unlink(artifactPathFor(input.path, input.kind, input.name));
      return true;
    } catch (error) {
      const gone =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!gone) {
        console.error("Failed to delete artifact", error);
      }
      return gone;
    }
  });
