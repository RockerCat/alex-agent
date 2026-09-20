import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { formatLocalDateTime } from "@/components/LocalDateTime";

// Regression for the Dashboard "Recent activity" timezone bug: a
// Server Component (app/(app)/dashboard/page.tsx) previously called
// toLocaleString() directly, which runs on the server (effectively UTC
// on Vercel) rather than the visitor's real browser timezone. The fix
// moved formatting into a Client Component (components/LocalDateTime.tsx)
// so this exact logic actually executes in the browser. This test
// proves the underlying formatting is a genuine timezone conversion —
// not just an identity/UTC passthrough — across a real date boundary:
// 2026-09-20T00:11:51Z is still September 19th local time in
// America/Bogota (UTC-5, no DST).
//
// process.env.TZ stands in for "the visitor's browser timezone" here —
// formatLocalDateTime() itself never hardcodes any timezone; it always
// defers to whatever timezone it runs in, exactly like a real browser's
// Date/Intl would for its own local zone.

describe("formatLocalDateTime", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("renders a UTC instant in the runtime's local timezone, crossing the date boundary correctly", () => {
    const result = formatLocalDateTime("2026-09-20T00:11:51Z");

    expect(result).toBe("9/19/2026, 7:11:51 PM");
  });

  it("never renders the raw UTC date/time for an instant that falls on a different local day", () => {
    const result = formatLocalDateTime("2026-09-20T00:11:51Z");

    expect(result).not.toContain("9/20/2026");
    expect(result).not.toContain("12:11:51 AM");
  });

  it("is not hardcoded to America/Bogota — a different runtime timezone produces a different result", () => {
    process.env.TZ = "UTC";

    const result = formatLocalDateTime("2026-09-20T00:11:51Z");

    expect(result).toBe("9/20/2026, 12:11:51 AM");
  });
});
