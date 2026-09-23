import type { Metadata } from "next";
import { EmailActionConfirm } from "@/components/EmailActionConfirm";

// Public email-action confirmation page (Email HITL Phase 2B). Reachable
// without an AlexAgent session via proxy.ts's PUBLIC_PATHS. The one-time
// token travels in the URL fragment (#t=…), which the browser never sends
// to the server, so this server-rendered shell never sees it: the client
// component reads it, inspects it read-only, and only an explicit click
// POSTs the decision. Loading this page can never approve or reject anything.

export const metadata: Metadata = {
  title: "Confirmar decisión — AlexAgent",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function EmailActionPage() {
  return (
    <div className="flex min-h-full flex-1 justify-center px-4 py-12">
      <main
        className="w-full max-w-lg space-y-4 rounded-lg border p-6"
        style={{ borderColor: "var(--border)", background: "var(--card)" }}
      >
        <EmailActionConfirm />
      </main>
    </div>
  );
}
