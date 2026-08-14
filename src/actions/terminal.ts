import { ipc } from "@/ipc/manager";
import type { TerminalEvent } from "@/types/terminal";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/** Names one shell: a worktree has as many as the user opens. */
export interface TerminalTarget {
  terminalId: string;
  worktreePath: string;
}

/**
 * Opens a stream of one terminal's shell. The scrollback arrives first, then
 * live output, until the signal aborts.
 */
export function attachTerminal(
  target: TerminalTarget,
  size: TerminalSize,
  signal: AbortSignal
): Promise<AsyncIterable<TerminalEvent>> {
  return ipc.client.terminal.attach({ ...target, ...size }, { signal });
}

export function writeToTerminal(
  target: TerminalTarget,
  data: string
): Promise<{ delivered: boolean }> {
  return ipc.client.terminal.write({ ...target, data });
}

export function resizeTerminal(
  target: TerminalTarget,
  size: TerminalSize
): Promise<{ ok: boolean }> {
  return ipc.client.terminal.resize({ ...target, ...size });
}

export function restartTerminal(
  target: TerminalTarget,
  size: TerminalSize
): Promise<{ ok: true }> {
  return ipc.client.terminal.restart({ ...target, ...size });
}

export function killTerminal(target: TerminalTarget): Promise<{ ok: true }> {
  return ipc.client.terminal.kill(target);
}

/**
 * Which terminals the worktree already has. Asked on mount rather than kept in
 * the renderer, so a remount rejoins the running shells instead of orphaning
 * them behind a list that starts empty.
 */
export function listTerminals(
  worktreePath: string
): Promise<{ terminalIds: string[] }> {
  return ipc.client.terminal.list({ worktreePath });
}

/** Stops every shell under a directory — used when a project tab closes. */
export function killTerminalsUnder(prefix: string): Promise<{ ok: true }> {
  return ipc.client.terminal.killUnder({ prefix });
}
