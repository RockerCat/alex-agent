"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export function RunCycleButton({
  action,
  disabled,
  disabledReason,
}: {
  action: () => Promise<void>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  return (
    <div className="space-y-1">
      <button
        type="button"
        disabled={disabled || isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await action();
              router.refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Failed to run marketing cycle.");
            }
          });
        }}
        className="rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
        style={{ background: "var(--accent)", color: "#0f172a" }}
      >
        {isPending ? "Running…" : "Run Marketing Cycle"}
      </button>
      {disabled && disabledReason && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {disabledReason}
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
