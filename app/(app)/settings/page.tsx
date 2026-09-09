import { supabaseAdmin } from "@/lib/supabase/admin";
import { updateSettingsAction } from "@/app/actions";

export const dynamic = "force-dynamic";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      {children}
    </div>
  );
}

export default async function SettingsPage() {
  const db = supabaseAdmin();
  const { data: settings } = await db.from("agent_settings").select("*").eq("singleton", true).single();

  if (!settings) {
    return <p className="text-sm text-red-600">agent_settings row is missing — check the database seed.</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm" style={{ color: "var(--muted)" }}>
          v0.1 exposes only the budget guard and execution controls defined by the spec.
        </p>
      </div>

      <form action={updateSettingsAction} className="space-y-4">
        <Card>
          <h2 className="font-medium mb-3">AI Budget Guard</h2>
          <div className="space-y-3">
            <label className="block text-sm">
              Monthly AI budget (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                name="monthly_budget_usd"
                required
                defaultValue={settings.monthly_budget_usd}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)", background: "var(--background)" }}
              />
            </label>
            <label className="block text-sm">
              Safety reserve (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                name="safety_reserve_usd"
                required
                defaultValue={settings.safety_reserve_usd}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)", background: "var(--background)" }}
              />
            </label>
            <label className="block text-sm">
              Per-run AI limit (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                name="per_run_budget_usd"
                required
                defaultValue={settings.per_run_budget_usd}
                className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
                style={{ borderColor: "var(--border)", background: "var(--background)" }}
              />
            </label>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              AlexAgent can never raise its own budget — this is the only place it changes.
            </p>
          </div>
        </Card>

        <Card>
          <h2 className="font-medium mb-3">Execution</h2>
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="solardesk_enabled" defaultChecked={settings.solardesk_enabled} />
              SolarDesk enabled
            </label>
            <div className="text-sm">
              <span style={{ color: "var(--muted)" }}>Approval policy: </span>
              <span className="font-medium">{settings.approval_policy}</span>
            </div>
            <div className="text-sm">
              <span style={{ color: "var(--muted)" }}>Execution mode: </span>
              <span className="font-medium">{settings.execution_mode}</span>
            </div>
            <p className="text-xs" style={{ color: "var(--muted)" }}>
              v0.1 only supports manual runs with mandatory approval on every piece of content.
            </p>
          </div>
        </Card>

        <button
          type="submit"
          className="rounded-md px-4 py-2 text-sm font-semibold"
          style={{ background: "var(--accent)", color: "#0f172a" }}
        >
          Save settings
        </button>
      </form>
    </div>
  );
}
