import type { AgentStatus } from "@/lib/agent/dashboardData";

const LABELS: Record<AgentStatus, string> = {
  ready: "Ready",
  running: "Running",
  needs_input: "Needs input",
  budget_paused: "Budget paused",
  disabled: "Disabled",
};

const COLORS: Record<AgentStatus, { bg: string; fg: string }> = {
  ready: { bg: "#dcfce7", fg: "#166534" },
  running: { bg: "#dbeafe", fg: "#1e40af" },
  needs_input: { bg: "#fef3c7", fg: "#92400e" },
  budget_paused: { bg: "#fee2e2", fg: "#991b1b" },
  disabled: { bg: "#e5e7eb", fg: "#374151" },
};

export function StatusBadge({ status }: { status: AgentStatus }) {
  const c = COLORS[status];
  return (
    <span
      className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ background: c.bg, color: c.fg }}
    >
      {LABELS[status]}
    </span>
  );
}
