// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { createElement, act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { LocalDateTime } from "@/components/LocalDateTime";

// Regression for the real Production bug: LocalDateTime previously
// computed its timezone-dependent text directly during render and
// relied on suppressHydrationWarning to paper over the server/client
// mismatch. suppressHydrationWarning only suppresses the dev warning —
// it does NOT guarantee React replaces the server-rendered (UTC) text
// with the client-computed one, and with no state/effect to trigger a
// genuine post-hydration render, Production could permanently display
// the server/UTC string. tests/localDateTime.test.ts already proves
// formatLocalDateTime() itself is a correct timezone conversion; this
// file proves the *lifecycle* around it — that the correct value
// actually reaches and stays in the DOM after a real server-render →
// hydrate → mount sequence, using only the browser-local effect that
// runs on every real page load, never an incidental extra render.
//
// This is the one test file in the repo that needs a real DOM (jsdom),
// scoped narrowly via the per-file `@vitest-environment` directive
// above rather than changing the global (Node) test environment.

describe("LocalDateTime — SSR then hydrate", () => {
  const originalTz = process.env.TZ;
  const KNOWN_INSTANT = "2026-09-20T00:11:51Z";

  afterEach(() => {
    process.env.TZ = originalTz;
    document.body.innerHTML = "";
  });

  it("1. the initial server-rendered HTML contains only the neutral placeholder, never a server-timezone-formatted timestamp", () => {
    process.env.TZ = "UTC"; // simulates the Vercel server

    const html = renderToString(createElement(LocalDateTime, { iso: KNOWN_INSTANT }));

    expect(html).not.toContain("9/20/2026");
    expect(html).not.toContain("12:11:51");
    expect(html).toContain("—");
  });

  it("2. after mounting in a different (browser) timezone, the DOM shows that timezone's local value — reached via the mount effect alone, not an incidental extra render", async () => {
    process.env.TZ = "UTC"; // server renders under UTC
    const serverHtml = renderToString(createElement(LocalDateTime, { iso: KNOWN_INSTANT }));

    const container = document.createElement("div");
    container.innerHTML = serverHtml;
    document.body.appendChild(container);

    // The "browser" in this scenario is Colombia — switched only now,
    // after the server HTML already exists, exactly like a real
    // UTC-server / Bogota-browser mismatch.
    process.env.TZ = "America/Bogota";

    await act(async () => {
      hydrateRoot(container, createElement(LocalDateTime, { iso: KNOWN_INSTANT }));
    });

    expect(container.textContent).toBe("9/19/2026, 7:11:51 PM");
  });

  it("3. reformats correctly when the iso prop changes after mount", async () => {
    process.env.TZ = "America/Bogota";
    const container = document.createElement("div");
    document.body.appendChild(container);

    let root: ReturnType<typeof import("react-dom/client")["createRoot"]>;
    await act(async () => {
      root = (await import("react-dom/client")).createRoot(container);
      root.render(createElement(LocalDateTime, { iso: KNOWN_INSTANT }));
    });
    expect(container.textContent).toBe("9/19/2026, 7:11:51 PM");

    await act(async () => {
      root.render(createElement(LocalDateTime, { iso: "2026-01-01T05:00:00Z" }));
    });
    expect(container.textContent).toBe("1/1/2026, 12:00:00 AM");
  });
});
