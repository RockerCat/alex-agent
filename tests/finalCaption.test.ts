import { describe, it, expect } from "vitest";
import { composeFinalSocialCaption, baseSocialCaption, checkFinalSocialCaption, INSTAGRAM_CAPTION_MAX_LENGTH } from "@/lib/agent/finalCaption";
import { EXECUTOR_TEXT_LIMITS } from "@/lib/agent/schemas";

// The ONE canonical composer for the exact social caption: the finished-
// publication review email and both publishers use it, so the reviewed
// string is the string sent to Meta.

function draft(overrides: Partial<Parameters<typeof composeFinalSocialCaption>[0]> = {}) {
  return {
    caption: "Cotiza proyectos solares en minutos.",
    hook: "¿Sigues usando hojas de cálculo?",
    cta_text: "Comenzar gratis",
    cta_url: "https://solardesk.co/register" as string | null,
    hashtags: ["#energiasolar", "#solardesk"],
    ...overrides,
  };
}

describe("composeFinalSocialCaption", () => {
  it("caption, then the CTA destination, then the hashtags — each separated by a blank line", () => {
    expect(composeFinalSocialCaption(draft())).toBe(
      "Cotiza proyectos solares en minutos.\n\nhttps://solardesk.co/register\n\n#energiasolar #solardesk"
    );
  });

  it("does not duplicate a CTA destination already in the caption", () => {
    const text = composeFinalSocialCaption(draft({ caption: "Regístrate: https://solardesk.co/register hoy." }));
    expect(text.split("https://solardesk.co/register")).toHaveLength(2);
    expect(text).toBe("Regístrate: https://solardesk.co/register hoy.\n\n#energiasolar #solardesk");
  });

  it("derives the destination from a legacy combined CTA string, as before", () => {
    const text = composeFinalSocialCaption(draft({ cta_url: null, cta_text: "Comenzar gratis — https://solardesk.co/register" }));
    expect(text).toContain("\n\nhttps://solardesk.co/register\n\n");
  });

  it("appends no destination when there is none", () => {
    expect(composeFinalSocialCaption(draft({ cta_url: null, cta_text: "Aprende más" }))).toBe("Cotiza proyectos solares en minutos.\n\n#energiasolar #solardesk");
  });

  it("does not repeat hashtags already present in the caption (case-insensitive)", () => {
    const text = composeFinalSocialCaption(draft({ caption: "Energía limpia #EnergiaSolar para todos.", cta_url: null, cta_text: "x" }));
    expect(text).toBe("Energía limpia #EnergiaSolar para todos.\n\n#solardesk");
  });

  it("treats a longer hashtag as different (#solar is not present in #solardesk)", () => {
    const text = composeFinalSocialCaption(draft({ caption: "Hola #solardesk", cta_url: null, cta_text: "x", hashtags: ["#solar", "#solardesk"] }));
    expect(text).toBe("Hola #solardesk\n\n#solar");
  });

  it("normalizes tags deterministically, never inventing any, and dedupes within the list", () => {
    const text = composeFinalSocialCaption(draft({ cta_url: null, cta_text: "x", hashtags: ["solar", "##Solar", " #energia ", "two words", "", "#energia"] }));
    expect(text).toBe("Cotiza proyectos solares en minutos.\n\n#solar #energia");
  });

  it("leaves the caption unchanged (besides the CTA) when there are no hashtags", () => {
    expect(composeFinalSocialCaption(draft({ hashtags: [] }))).toBe("Cotiza proyectos solares en minutos.\n\nhttps://solardesk.co/register");
  });

  it("falls back to the hook when there is no caption, and is empty when neither exists", () => {
    expect(composeFinalSocialCaption(draft({ caption: null, cta_url: null, cta_text: "x", hashtags: [] }))).toBe("¿Sigues usando hojas de cálculo?");
    expect(composeFinalSocialCaption(draft({ caption: null, hook: null }))).toBe("");
    expect(baseSocialCaption({ caption: "  ", hook: null })).toBe("");
  });
});

describe("one canonical composer everywhere", () => {
  it("both publishers and the finished-publication email use composeFinalSocialCaption — no other caption composition exists", async () => {
    const { readFile } = await import("node:fs/promises");
    const publish = await readFile("lib/agent/publish.ts", "utf-8");
    // Facebook composes directly; Instagram composes via checkFinalSocialCaption (same composer + its limit check).
    expect(publish.match(/const caption = composeFinalSocialCaption\(draft\);/g)).toHaveLength(1);
    expect(publish).toMatch(/checkFinalSocialCaption\(draft, "instagram"\)[\s\S]*const caption = captionCheck\.caption;/);
    expect(publish).not.toMatch(/composeCaptionWithCtaDestination|resolveCtaLabelAndUrl/);
    const templates = await readFile("lib/agent/emailTemplates.ts", "utf-8");
    expect(templates).toMatch(/composeFinalSocialCaption\(draft\)/);
  });
});

describe("publication-approval confirmation wording", () => {
  it("states the exact single channel and that nothing is published automatically", async () => {
    const { publicationApprovalScope } = await import("@/components/EmailActionConfirm");
    const text = publicationApprovalScope({
      action: "approve_asset",
      brandDisplayName: "SolarDesk",
      title: "t",
      channel: "facebook",
      contentType: "image_post",
      contentVersion: 1,
      assetVersion: 1,
    });
    expect(text).toBe("Apruebas esta imagen y este texto exactos solo para Facebook. AlexAgent todavía no publica automáticamente: la pieza quedará lista para publicar.");
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("components/EmailActionConfirm.tsx", "utf-8");
    expect(source).toContain('question: "¿Aprobar esta publicación?"');
    expect(source).toContain('button: "Confirmar aprobación de la publicación"');
    expect(source).not.toContain("¿Aprobar esta imagen?");
  });
});

describe("checkFinalSocialCaption — destination caption constraints on the EXACT composed caption", () => {
  const URL = "https://solardesk.co/register"; // 29 chars
  const TAGS_SUFFIX = "\n\n#energiasolar #solardesk"; // 27 chars
  const plain = (caption: string) => draft({ caption, cta_url: null, cta_text: "x", hashtags: [] });

  it("uses the project's existing 2,200-character caption limit (not a new number)", () => {
    expect(INSTAGRAM_CAPTION_MAX_LENGTH).toBe(EXECUTOR_TEXT_LIMITS.caption);
    expect(INSTAGRAM_CAPTION_MAX_LENGTH).toBe(2200);
  });

  it("accepts an Instagram final caption within the limit and returns exactly the composed caption", () => {
    const d = draft({ caption: "a".repeat(1000) });
    const check = checkFinalSocialCaption(d, "instagram");
    expect(check).toEqual({ ok: true, caption: composeFinalSocialCaption(d) });
  });

  it("accepts exactly 2,200 and rejects 2,201", () => {
    expect(checkFinalSocialCaption(plain("a".repeat(2200)), "instagram").ok).toBe(true);
    const over = checkFinalSocialCaption(plain("a".repeat(2201)), "instagram");
    expect(over).toEqual({
      ok: false,
      reason: "The final Instagram caption (caption + CTA link + hashtags) is 2201 characters; Instagram allows at most 2200. It was not truncated.",
    });
  });

  it("rejects when the appended CTA destination pushes an otherwise-valid caption over the limit", () => {
    const caption = "a".repeat(2180);
    const d = draft({ caption, cta_url: URL, hashtags: [] });
    expect(caption.length).toBeLessThanOrEqual(EXECUTOR_TEXT_LIMITS.caption); // the draft caption alone is valid
    expect(composeFinalSocialCaption(d)).toHaveLength(2180 + 2 + URL.length);
    expect(checkFinalSocialCaption(d, "instagram").ok).toBe(false);
  });

  it("rejects when the appended hashtags push an otherwise-valid caption over the limit", () => {
    const d = draft({ caption: "a".repeat(2190), cta_url: null, cta_text: "x" });
    expect(composeFinalSocialCaption(d)).toHaveLength(2190 + TAGS_SUFFIX.length);
    expect(checkFinalSocialCaption(d, "instagram").ok).toBe(false);
  });

  it("never truncates or drops the CTA/hashtags, and the reason never contains caption text", () => {
    const d = draft({ caption: "SECRETO ".repeat(280) });
    const before = composeFinalSocialCaption(d);
    const check = checkFinalSocialCaption(d, "instagram");
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).not.toContain("SECRETO");
    expect(composeFinalSocialCaption(d)).toBe(before); // untouched: still contains the CTA and hashtags
    expect(before).toContain(URL);
    expect(before.endsWith("#energiasolar #solardesk")).toBe(true);
  });

  it("counts UTF-16 code units like the existing schema limit (conservative for emoji)", () => {
    const emoji = "😀"; // 1 character, 2 UTF-16 code units
    expect(checkFinalSocialCaption(plain(emoji.repeat(1100)), "instagram").ok).toBe(true); // 2200 units
    expect(checkFinalSocialCaption(plain(emoji.repeat(1100) + "a"), "instagram").ok).toBe(false);
  });

  it("Facebook behavior is unchanged: no length constraint, only an empty caption is refused", () => {
    const long = draft({ caption: "a".repeat(5000) });
    expect(checkFinalSocialCaption(long, "facebook")).toEqual({ ok: true, caption: composeFinalSocialCaption(long) });
    expect(checkFinalSocialCaption(draft({ caption: null, hook: null }), "facebook").ok).toBe(false);
  });
});
