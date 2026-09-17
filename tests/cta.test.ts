import { describe, it, expect } from "vitest";
import { isValidCtaUrl, containsEmbeddedUrl, deriveLegacyCtaLabelAndUrl, resolveCtaLabelAndUrl } from "@/lib/agent/cta";

// CTA label/destination contract (real production incident, 2026-09-17):
// a combined "label — URL" string in cta/cta_text overflowed the asset
// renderer's single-line CTA pill. These tests cover the shared
// resolver that lets new-style rows (cta_url populated) and legacy rows
// (cta_url null, URL still embedded in cta_text) both resolve to a
// clean {label, url} — without ever mutating stored data.

describe("isValidCtaUrl", () => {
  it("accepts https/http URLs", () => {
    expect(isValidCtaUrl("https://solardesk.co/register")).toBe(true);
    expect(isValidCtaUrl("http://solardesk.co/register")).toBe(true);
  });

  it("rejects non-URL text and non-http(s) schemes", () => {
    expect(isValidCtaUrl("Comenzar gratis")).toBe(false);
    expect(isValidCtaUrl("not a url at all")).toBe(false);
    expect(isValidCtaUrl("ftp://solardesk.co/file")).toBe(false);
    expect(isValidCtaUrl("javascript:alert(1)")).toBe(false);
  });
});

describe("containsEmbeddedUrl", () => {
  it("detects a URL embedded in a label", () => {
    expect(containsEmbeddedUrl("Comenzar gratis — https://solardesk.co/register")).toBe(true);
  });

  it("returns false for an ordinary short label", () => {
    expect(containsEmbeddedUrl("Comenzar gratis")).toBe(false);
  });
});

describe("deriveLegacyCtaLabelAndUrl", () => {
  it("splits the real production combined string into label + url", () => {
    const result = deriveLegacyCtaLabelAndUrl("Comenzar gratis — https://solardesk.co/register");
    expect(result.label).toBe("Comenzar gratis");
    expect(result.url).toBe("https://solardesk.co/register");
  });

  it("handles a plain space separator (no dash)", () => {
    const result = deriveLegacyCtaLabelAndUrl("Comenzar gratis https://solardesk.co/register");
    expect(result.label).toBe("Comenzar gratis");
    expect(result.url).toBe("https://solardesk.co/register");
  });

  it("treats an ordinary label with no URL as the label, with a null destination", () => {
    const result = deriveLegacyCtaLabelAndUrl("Comenzar gratis");
    expect(result.label).toBe("Comenzar gratis");
    expect(result.url).toBeNull();
  });

  it("never fabricates a destination from arbitrary trailing text that isn't a real URL", () => {
    const result = deriveLegacyCtaLabelAndUrl("Comenzar gratis - hoy mismo");
    expect(result.label).toBe("Comenzar gratis - hoy mismo");
    expect(result.url).toBeNull();
  });
});

describe("resolveCtaLabelAndUrl", () => {
  it("uses cta_url directly when present (new-style row)", () => {
    const result = resolveCtaLabelAndUrl({ cta_text: "Comenzar gratis", cta_url: "https://solardesk.co/register" });
    expect(result).toEqual({ label: "Comenzar gratis", url: "https://solardesk.co/register" });
  });

  it("falls back to legacy derivation when cta_url is null (real production draft, unmodified)", () => {
    const result = resolveCtaLabelAndUrl({
      cta_text: "Comenzar gratis — https://solardesk.co/register",
      cta_url: null,
    });
    expect(result).toEqual({ label: "Comenzar gratis", url: "https://solardesk.co/register" });
  });

  it("treats a malformed cta_url as no destination rather than sending it anywhere", () => {
    const result = resolveCtaLabelAndUrl({ cta_text: "Comenzar gratis", cta_url: "not-a-url" });
    expect(result).toEqual({ label: "Comenzar gratis", url: null });
  });
});
