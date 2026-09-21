import type { Metadata } from "next";

// Public Privacy Policy page (Meta app-review requirement). Made
// reachable without an AlexAgent login session via proxy.ts's
// PUBLIC_PATHS — see that file for the exact, narrowly-scoped exemption.
// Contact address below (alexsosa.me@gmail.com) is the explicitly
// provided public AlexAgent contact for this policy.

export const metadata: Metadata = {
  title: "Privacy Policy — AlexAgent",
  description: "AlexAgent privacy policy",
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

export default function PrivacyPolicyPage() {
  return (
    <div className="flex min-h-full flex-1 justify-center px-4 py-12">
      <article
        className="w-full max-w-2xl space-y-6 rounded-lg border p-8"
        style={{ borderColor: "var(--border)", background: "var(--card)" }}
      >
        <header className="space-y-1">
          <h1 className="text-xl font-semibold">Privacy Policy — AlexAgent</h1>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Last updated: September 21, 2026
          </p>
        </header>

        <Section title="Overview">
          <p>
            AlexAgent is a private, single-owner AI-assisted marketing operations tool. It is not a
            consumer-facing product or a public social network — it helps its owner plan, draft,
            review, and publish marketing content for a small number of brands.
          </p>
        </Section>

        <Section title="Third-party integrations">
          <p>
            Depending on which integration is enabled for a given brand, AlexAgent may connect to
            third-party platforms such as Meta/Facebook, Instagram, and WhatsApp to support
            marketing-content workflows, publishing, operational notifications, and related
            functions.
          </p>
        </Section>

        <Section title="Information we process">
          <p>
            To perform those functions, AlexAgent may process information such as: account/platform
            identifiers needed to publish or notify through a connected service; content and
            publication metadata (e.g. what was posted, when, and its status); message/notification
            delivery status (e.g. sent, delivered, read, failed); and other information explicitly
            provided through a connected service in order to carry out the requested action.
          </p>
        </Section>

        <Section title="How information is used">
          <p>
            Information is used only to operate, secure, maintain, and improve the specific AlexAgent
            functionality it was collected for. AlexAgent does not sell personal information.
          </p>
        </Section>

        <Section title="Sharing">
          <p>
            Information is not shared with third parties except: (a) the service providers/platforms
            necessary to provide the requested functionality (for example, sending a message through
            WhatsApp, or publishing a post through Facebook or Instagram), or (b) where required by
            law.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Reasonable technical and organizational safeguards are used to protect information
            processed by AlexAgent against unauthorized access, use, or disclosure.
          </p>
        </Section>

        <Section title="Retention">
          <p>
            Information is retained only for as long as reasonably necessary for the operational
            purpose it was collected for, or as required to meet legal obligations.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You may request information about, correction of, or deletion of applicable personal data
            by contacting the service owner at{" "}
            <span className="font-medium" style={{ color: "var(--accent)" }}>
              alexsosa.me@gmail.com
            </span>
            .
          </p>
        </Section>

        <Section title="Third-party platforms">
          <p>
            Meta, Facebook, Instagram, WhatsApp, and any other connected third-party service remain
            governed by their own respective privacy policies and terms of service, independent of
            this policy.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            This policy may be updated as AlexAgent&apos;s functionality evolves. The date above reflects
            the most recent update.
          </p>
        </Section>
      </article>
    </div>
  );
}
