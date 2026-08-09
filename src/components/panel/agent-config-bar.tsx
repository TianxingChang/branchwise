import { useCallback } from "react";
import {
  AGENT_DRIVER_IDS,
  type AgentConfig,
  type AgentDriverId,
  PERMISSION_TIERS,
  type PermissionTier,
} from "@/types/agent";
import { cn } from "@/utils/tailwind";

const DRIVER_LABELS: Record<AgentDriverId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

const TIER_LABELS: Record<PermissionTier, string> = {
  "accept-edits": "Accept edits",
  ask: "Ask",
  plan: "Plan",
  yolo: "Yolo",
};

/**
 * There is no bw-danger token in global.css (checked) — every other error
 * state in this panel (file-tab, terminal-tab) renders in bw-pending amber,
 * so red is introduced here for the first time, deliberately, to mark yolo as
 * a different order of risk: it skips every permission prompt, not just the
 * ones a single tool would have asked.
 */
const YOLO_WARNING_CLASS = "text-red-600";

const YOLO_CONFIRM_MESSAGE =
  "Yolo skips every permission prompt — the agent can run any command or edit any file without asking first. Continue?";

interface AgentConfigBarProps {
  config: AgentConfig;
  hasConversation: boolean;
  onChange: (config: AgentConfig) => void;
}

export default function AgentConfigBar({
  config,
  hasConversation,
  onChange,
}: AgentConfigBarProps) {
  const handleDriverChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      onChange({ ...config, driverId: event.target.value as AgentDriverId });
    },
    [config, onChange]
  );

  const handleTierChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const tier = event.target.value as PermissionTier;
      // biome-ignore lint/suspicious/noAlert: the brief specifies window.confirm as the v1 gate for yolo; a custom modal is future work.
      if (tier === "yolo" && !window.confirm(YOLO_CONFIRM_MESSAGE)) {
        // Leaving onChange uncalled snaps the controlled <select> back to
        // config.tier on the next render — no separate "revert" state needed.
        return;
      }
      onChange({ ...config, tier });
    },
    [config, onChange]
  );

  return (
    <div className="flex items-center gap-3 border-bw-hairline border-t px-3 py-2">
      <span className="flex items-center gap-1.5 text-[11px] text-bw-muted">
        Backend
        <select
          aria-label="Agent backend"
          className="rounded-md border border-bw-hairline bg-bw-surface px-1.5 py-1 font-mono text-[11px] text-bw-ink outline-none focus:border-bw-edge disabled:opacity-50"
          disabled={hasConversation}
          onChange={handleDriverChange}
          value={config.driverId}
        >
          {AGENT_DRIVER_IDS.map((id) => (
            <option key={id} value={id}>
              {DRIVER_LABELS[id]}
            </option>
          ))}
        </select>
      </span>

      <span className="flex items-center gap-1.5 text-[11px] text-bw-muted">
        Tier
        <select
          aria-label="Permission tier"
          className={cn(
            "rounded-md border bg-bw-surface px-1.5 py-1 font-mono text-[11px] outline-none focus:border-bw-edge",
            config.tier === "yolo"
              ? cn("border-red-600/40", YOLO_WARNING_CLASS)
              : "border-bw-hairline text-bw-ink"
          )}
          onChange={handleTierChange}
          value={config.tier}
        >
          {PERMISSION_TIERS.map((tier) => (
            <option key={tier} value={tier}>
              {TIER_LABELS[tier]}
            </option>
          ))}
        </select>
      </span>

      {config.tier === "yolo" ? (
        <span className={cn("text-[10.5px]", YOLO_WARNING_CLASS)}>
          Runs without asking
        </span>
      ) : null}
    </div>
  );
}
