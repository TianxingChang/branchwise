import { describe, expect, test } from "vitest";
import {
  artifactFileName,
  parseArtifactFileName,
  sanitizeArtifactName,
  uniqueArtifactName,
} from "@/lib/artifacts/naming";

describe("artifactFileName", () => {
  test("appends the kind's extension", () => {
    expect(artifactFileName("note", "Meeting notes")).toBe("Meeting notes.md");
    expect(artifactFileName("canvas", "Sketch")).toBe("Sketch.tldr");
  });
});

describe("parseArtifactFileName", () => {
  test("round-trips what artifactFileName produces", () => {
    expect(parseArtifactFileName("Meeting notes.md")).toEqual({
      kind: "note",
      name: "Meeting notes",
    });
    expect(parseArtifactFileName("Sketch.tldr")).toEqual({
      kind: "canvas",
      name: "Sketch",
    });
  });

  test("rejects files the shelf does not own", () => {
    expect(parseArtifactFileName("README.txt")).toBeNull();
    expect(parseArtifactFileName("noextension")).toBeNull();
    expect(parseArtifactFileName(".DS_Store")).toBeNull();
    // An extension alone is not an artifact — there is no name left.
    expect(parseArtifactFileName(".md")).toBeNull();
  });

  test("keeps inner dots in the name", () => {
    expect(parseArtifactFileName("v2.plan.md")).toEqual({
      kind: "note",
      name: "v2.plan",
    });
  });
});

describe("sanitizeArtifactName", () => {
  test("passes ordinary names through trimmed", () => {
    expect(sanitizeArtifactName("  Meeting notes ")).toBe("Meeting notes");
    expect(sanitizeArtifactName("v2.plan")).toBe("v2.plan");
  });

  test("rejects empty and dot-leading names", () => {
    expect(sanitizeArtifactName("")).toBeNull();
    expect(sanitizeArtifactName("   ")).toBeNull();
    expect(sanitizeArtifactName(".hidden")).toBeNull();
  });

  test("rejects anything that could leave the shelf directory", () => {
    expect(sanitizeArtifactName("a/b")).toBeNull();
    expect(sanitizeArtifactName("a\\b")).toBeNull();
    expect(sanitizeArtifactName("..")).toBeNull();
    expect(sanitizeArtifactName("a\0b")).toBeNull();
  });

  test("rejects names longer than 80 characters", () => {
    expect(sanitizeArtifactName("a".repeat(80))).toBe("a".repeat(80));
    expect(sanitizeArtifactName("a".repeat(81))).toBeNull();
  });
});

describe("uniqueArtifactName", () => {
  test("returns the base when free", () => {
    expect(uniqueArtifactName(new Set(), "Note")).toBe("Note");
  });

  test("counts up from 2 past taken names", () => {
    expect(uniqueArtifactName(new Set(["note"]), "Note")).toBe("Note 2");
    expect(uniqueArtifactName(new Set(["note", "note 2"]), "Note")).toBe(
      "Note 3"
    );
  });

  test("compares case-insensitively — APFS will", () => {
    expect(uniqueArtifactName(new Set(["NOTE"]), "note")).toBe("note 2");
  });
});
