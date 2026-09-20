import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeLocalSpendBoundaries } from "@/components/DailySpend";

// Dashboard "Today"/"Daily avg.": proves the boundary math actually
// used by components/DailySpend.tsx converts a real instant into the
// correct *local* calendar-day/month boundaries and elapsed-day count —
// mirroring tests/localDateTime.test.ts's approach for the Recent
// Activity timezone fix. process.env.TZ stands in for "the visitor's
// browser timezone" — computeLocalSpendBoundaries() itself never
// hardcodes any timezone, it always defers to whatever timezone it
// actually runs in, exactly like a real browser's Date would for its
// own local zone.

describe("computeLocalSpendBoundaries", () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    process.env.TZ = "America/Bogota";
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  it("maps a UTC instant to the correct local day/month boundaries, crossing the date boundary correctly", () => {
    // 2026-09-20T00:11:51Z is 2026-09-19 19:11:51 local in America/Bogota (UTC-5).
    const result = computeLocalSpendBoundaries(new Date("2026-09-20T00:11:51Z"));

    expect(result.todayStartIso).toBe("2026-09-19T05:00:00.000Z");
    expect(result.monthStartIso).toBe("2026-09-01T05:00:00.000Z");
    expect(result.elapsedLocalDays).toBe(19);
  });

  it("is not hardcoded to America/Bogota — a different runtime timezone produces different boundaries", () => {
    process.env.TZ = "UTC";

    const result = computeLocalSpendBoundaries(new Date("2026-09-20T00:11:51Z"));

    expect(result.todayStartIso).toBe("2026-09-20T00:00:00.000Z");
    expect(result.monthStartIso).toBe("2026-09-01T00:00:00.000Z");
    expect(result.elapsedLocalDays).toBe(20);
  });

  it("the first day of a local month has elapsedLocalDays = 1, never 0", () => {
    const result = computeLocalSpendBoundaries(new Date("2026-09-01T05:30:00Z")); // 2026-09-01 00:30 local Bogota

    expect(result.elapsedLocalDays).toBe(1);
    expect(result.todayStartIso).toBe(result.monthStartIso);
  });
});
