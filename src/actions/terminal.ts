import { ipc } from "@/ipc/manager";
import type { TerminalEvent } from "@/types/terminal";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Opens a stream of the worktree's shell. The scrollback arrives first, then
 * live output, until the signal aborts.
 */
export function attachTerminal(
  worktreePath: string,
  size: TerminalSize,
  signal: AbortSignal
): Promise<AsyncIterable<TerminalEvent>> {
  return ipc.client.terminal.attach({ ...size, worktreePath }, { signal });
}

export function writeToTerminal(
  worktreePath: string,
  data: string
): Promise<{ delivered: boolean }> {
  return ipc.client.terminal.write({ data, worktreePath });
}

export function resizeTerminal(
  worktreePath: string,
  size: TerminalSize
): Promise<{ ok: boolean }> {
  return ipc.client.terminal.resize({ ...size, worktreePath });
}

export function restartTerminal(
  worktreePath: string,
  size: TerminalSize
): Promise<{ ok: true }> {
  return ipc.client.terminal.restart({ ...size, worktreePath });
}

export function killTerminal(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.terminal.kill({ worktreePath });
}

/** Stops every shell under a directory — used when a project tab closes. */
export function killTerminalsUnder(prefix: string): Promise<{ ok: true }> {
  return ipc.client.terminal.killUnder({ prefix });
}
