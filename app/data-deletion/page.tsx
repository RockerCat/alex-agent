import type { Metadata } from "next";

// Public Data Deletion Instructions page (Meta app-review requirement).
// Made reachable without an AlexAgent login session via proxy.ts's
// PUBLIC_PATHS — see that file for the exact, narrowly-scoped exemption.
// Same architectural/visual pattern as app/privacy/page.tsx.

export const metadata: Metadata = {
  title: "Data Deletion Instructions — AlexAgent",
  description: "How to request deletion of data associated with AlexAgent",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
        {children}
      </div>
    </section>
  );
}

export default function DataDeletionPage() {
  return (
    <div className="flex min-h-full flex-1 justify-center px-4 py-12">
      <article
        className="w-full max-w-2xl space-y-6 rounded-lg border p-8"
        style={{ borderColor: "var(--border)", background: "var(--card)" }}
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Data Deletion Instructions — AlexAgent</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Last updated: September 21, 2026
          </p>
        </header>

        <Section title="Overview">
          <p>
            AlexAgent is a private, single-owner AI-assisted marketing operations tool. If you would
            like personal data associated with your use of, or interaction with, AlexAgent deleted,
            you may request this at any time.
          </p>
        </Section>

        <Section title="How to request deletion">
          <p>
            Send an email to{" "}
            <span className="font-medium" style={{ color: "var(--accent)" }}>
              alexsosa.me@gmail.com
            </span>{" "}
            with the subject line{" "}
            <span className="font-medium" style={{ color: "var(--accent)" }}>
              AlexAgent Data Deletion Request
            </span>
            . Please include only enough information to identify the relevant account or integration
            (for example, the platform involved and how it connects to AlexAgent), so the request can
            be located and processed.
          </p>
        </Section>

        <Section title="What not to send">
          <p>
            Do not include passwords, access tokens, API keys, or any other credentials in your
            request. AlexAgent will never ask for these to process a deletion request.
          </p>
        </Section>

        <Section title="What happens next">
          <p>
            Each request is reviewed individually, and applicable AlexAgent-controlled data
            associated with the request will be deleted or anonymized as appropriate. Some
            information may be retained where reasonably necessary for security, fraud prevention,
            legal obligations, dispute resolution, or other legitimate record-keeping requirements.
          </p>
        </Section>

        <Section title="Data held by third-party platforms">
          <p>
            AlexAgent connects to third-party platforms such as Meta, Facebook, Instagram, and
            WhatsApp. Deletion of data held independently by those platforms must be requested
            directly through their own respective procedures — AlexAgent cannot delete data it does
            not control.
          </p>
        </Section>

        <Section title="Questions">
          <p>
            For any questions about this process, contact{" "}
            <span className="font-medium" style={{ color: "var(--accent)" }}>
              alexsosa.me@gmail.com
            </span>
            .
          </p>
        </Section>
      </article>
    </div>
  );
}
