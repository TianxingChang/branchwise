import { ipc } from "@/ipc/manager";
import type { AgentConfig, AgentEvent } from "@/types/agent";

export function attachAgent(
  worktreePath: string,
  signal: AbortSignal
): Promise<AsyncIterable<AgentEvent>> {
  return ipc.client.agent.attach({ worktreePath }, { signal });
}

export function sendAgentMessage(
  worktreePath: string,
  text: string
): Promise<{ accepted: boolean; reason?: string }> {
  return ipc.client.agent.send({ text, worktreePath });
}

export function interruptAgent(worktreePath: string): Promise<{ ok: true }> {
  return ipc.client.agent.interrupt({ worktreePath });
}

export function respondAgentPermission(input: {
  approved: boolean;
  requestId: string;
  worktreePath: string;
}): Promise<{ ok: boolean }> {
  return ipc.client.agent.respondPermission(input);
}

export function getAgentConfig(worktreePath: string) {
  return ipc.client.agent.getConfig({ worktreePath });
}

export function setAgentConfig(worktreePath: string, config: AgentConfig) {
  return ipc.client.agent.setConfig({ config, worktreePath });
}

export function agentHistory(worktreePath: string): Promise<AgentEvent[]> {
  return ipc.client.agent.history({ worktreePath });
}
