import { ipc } from "@/ipc/manager";
import type { AgentConfig, AgentEvent } from "@/types/agent";

/** Which conversation, in which worktree. */
export interface AgentTarget {
  conversationId: string;
  worktreePath: string;
}

export function attachAgent(
  target: AgentTarget,
  signal: AbortSignal
): Promise<AsyncIterable<AgentEvent>> {
  return ipc.client.agent.attach(target, { signal });
}

export function sendAgentMessage(
  target: AgentTarget,
  text: string
): Promise<{ accepted: boolean; reason?: string }> {
  return ipc.client.agent.send({ ...target, text });
}

export function interruptAgent(target: AgentTarget): Promise<{ ok: true }> {
  return ipc.client.agent.interrupt(target);
}

export function respondAgentPermission(
  input: AgentTarget & { approved: boolean; requestId: string }
): Promise<{ ok: boolean }> {
  return ipc.client.agent.respondPermission(input);
}

export function getAgentConfig(target: AgentTarget) {
  return ipc.client.agent.getConfig(target);
}

export function setAgentConfig(target: AgentTarget, config: AgentConfig) {
  return ipc.client.agent.setConfig({ ...target, config });
}

export function agentHistory(target: AgentTarget): Promise<AgentEvent[]> {
  return ipc.client.agent.history(target);
}

export function prepareAgentInheritance(input: {
  childWorktree: string;
  mode: "brief" | "full";
  parentLabel: string;
  parentWorktree: string;
}): Promise<{ ok: boolean; reason?: string }> {
  return ipc.client.agent.prepareInheritance(input);
}
