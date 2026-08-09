import { ipc } from "@/ipc/manager";
import type { ArtifactKind, ArtifactMeta } from "@/types/artifacts";

export function listArtifacts(path: string): Promise<ArtifactMeta[]> {
  return ipc.client.artifacts.list({ path });
}

export function createArtifact(
  path: string,
  kind: ArtifactKind
): Promise<ArtifactMeta | null> {
  return ipc.client.artifacts.create({ kind, path });
}

export function readArtifact(
  path: string,
  kind: ArtifactKind,
  name: string
): Promise<{ content: string } | null> {
  return ipc.client.artifacts.read({ kind, name, path });
}

export function writeArtifact(
  path: string,
  kind: ArtifactKind,
  name: string,
  content: string
): Promise<boolean> {
  return ipc.client.artifacts.write({ content, kind, name, path });
}

/** The returned meta carries the name actually taken — adopt it. */
export function renameArtifact(
  path: string,
  kind: ArtifactKind,
  name: string,
  to: string
): Promise<ArtifactMeta | null> {
  return ipc.client.artifacts.rename({ kind, name, path, to });
}

export function deleteArtifact(
  path: string,
  kind: ArtifactKind,
  name: string
): Promise<boolean> {
  return ipc.client.artifacts.remove({ kind, name, path });
}
