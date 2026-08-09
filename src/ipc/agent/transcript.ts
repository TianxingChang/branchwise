import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentEvent,
  type TranscriptLine,
  transcriptLineSchema,
} from "@/types/agent";

/** Short, filename-safe, stable identity for a worktree's transcript file. */
export function worktreeHash(worktreePath: string): string {
  return createHash("sha256")
    .update(path.resolve(worktreePath))
    .digest("hex")
    .slice(0, 16);
}

function transcriptFile(baseDir: string, worktreePath: string): string {
  return path.join(
    baseDir,
    "transcripts",
    `${worktreeHash(worktreePath)}.ndjson`
  );
}

export async function appendTranscript(
  baseDir: string,
  worktreePath: string,
  event: AgentEvent
): Promise<void> {
  const file = transcriptFile(baseDir, worktreePath);
  await mkdir(path.dirname(file), { recursive: true });
  const line: TranscriptLine = { at: Date.now(), event };
  await appendFile(file, `${JSON.stringify(line)}\n`, "utf8");
}

/**
 * Reads a transcript back as events, newest-last. A torn final line — the app
 * died mid-append — parses as nothing rather than poisoning the rebuild.
 */
export async function readTranscript(
  baseDir: string,
  worktreePath: string,
  limit = 2000
): Promise<AgentEvent[]> {
  let raw: string;
  try {
    raw = await readFile(transcriptFile(baseDir, worktreePath), "utf8");
  } catch {
    return [];
  }

  const events: AgentEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(transcriptLineSchema.parse(JSON.parse(line)).event);
    } catch {
      // Torn or foreign line: skip it, keep the rest.
    }
  }
  return events.slice(-limit);
}
