import { create, list, read, remove, renameArtifact, write } from "./handlers";

export const artifacts = {
  create,
  list,
  read,
  remove,
  rename: renameArtifact,
  write,
};
