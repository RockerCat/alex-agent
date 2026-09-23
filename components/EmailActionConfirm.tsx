"use client";

import { useEffect, useRef, useState } from "react";

// Client half of the email-action confirmation flow (see
// app/email/action/page.tsx and lib/agent/emailActions.ts). The token is
// read from the URL fragment once, removed from the address bar/history,
// kept only in memory, and sent only in POST bodies. Every value shown is
// rendered as React text (escaped); no internal ids are displayed.

type ActionName = "approve_draft" | "reject_draft" | "approve_asset";

interface ActionContext {
  action: ActionName;
  brandDisplayName: string;
  title: string;
  channel: string;
  contentType: string;
  contentVersion: number;
  assetVersion: number | null;
}

type Inspection =
  | { state: "invalid" | "error" }
  | { state: "expired"; context: ActionContext | null }
  | { state: "already_processed"; outcome: string | null; context: ActionContext | null }
  | { state: "ready" | "stale"; context: ActionContext }
  | { state: "not_actionable"; currentStatus: string; context: ActionContext };

type Confirmation =
  | { result: "invalid" | "error" }
  | { result: "expired" | "failed"; context: ActionContext | null }
  | { result: "already_processed"; outcome: string | null; context: ActionContext | null }
  | { result: "applied" | "stale"; context: ActionContext }
  | { result: "not_actionable"; currentStatus: string; context: ActionContext };

const ACTION_LABELS: Record<ActionName, { question: string; button: string; done: string }> = {
  approve_draft: { question: "¿Aprobar este contenido?", button: "Confirmar aprobación", done: "Contenido aprobado." },
  reject_draft: { question: "¿Rechazar este contenido?", button: "Confirmar rechazo", done: "Contenido rechazado." },
  approve_asset: { question: "¿Aprobar esta publicación?", button: "Confirmar aprobación de la publicación", done: "Publicación aprobada." },
};

const STATUS_LABELS: Record<string, string> = {
  approved: "aprobado",
  rejected: "rechazado",
  draft: "en preparación",
  revision_requested: "en revisión",
  scheduled: "programado",
  published: "publicado",
  ready_to_publish: "aprobada (lista para publicar)",
  generation_failed: "con error de generación",
};

const CHANNEL_LABELS: Record<string, string> = { instagram: "Instagram", facebook: "Facebook" };

function readTokenFromFragment(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  return params.get("t");
}

async function post<T>(path: string, token: string): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  return (await response.json()) as T;
}

function ContextSummary({ context }: { context: ActionContext }) {
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
      <dt style={{ color: "var(--muted)" }}>Marca</dt>
      <dd>{context.brandDisplayName}</dd>
      <dt style={{ color: "var(--muted)" }}>Contenido</dt>
      <dd>{context.title}</dd>
      <dt style={{ color: "var(--muted)" }}>Canal de destino</dt>
      <dd>{CHANNEL_LABELS[context.channel] ?? context.channel}</dd>
      <dt style={{ color: "var(--muted)" }}>Versión del contenido</dt>
      <dd>v{context.contentVersion}</dd>
      {context.assetVersion !== null && (
        <>
          <dt style={{ color: "var(--muted)" }}>Versión de la imagen</dt>
          <dd>v{context.assetVersion}</dd>
        </>
      )}
    </dl>
  );
}

function Message({ title, body, context }: { title: string; body?: string; context?: ActionContext | null }) {
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">{title}</h1>
      {body && <p className="text-sm">{body}</p>}
      {context && <ContextSummary context={context} />}
    </div>
  );
}

const ALREADY_PROCESSED_BODY = "Este enlace ya se usó. No se realizó ningún cambio nuevo.";

/** What approving a finished publication means — shown before confirming and after success. */
export function publicationApprovalScope(context: ActionContext): string {
  const channel = CHANNEL_LABELS[context.channel] ?? context.channel;
  return `Apruebas esta imagen y este texto exactos solo para ${channel}. AlexAgent todavía no publica automáticamente: la pieza quedará lista para publicar.`;
}

export function EmailActionConfirm() {
  // In memory only; never rendered, never re-sent anywhere but our own POST bodies.
  const tokenRef = useRef<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const fromFragment = readTokenFromFragment();
    // Remove the token from the visible URL and browser history right away.
    window.history.replaceState(null, "", window.location.pathname);
    tokenRef.current = fromFragment;

    async function load(): Promise<Inspection> {
      if (!fromFragment) return { state: "invalid" };
      try {
        return await post<Inspection>("/api/email-actions/inspect", fromFragment);
      } catch {
        return { state: "error" };
      }
    }
    void load().then(setInspection);
  }, []);

  async function confirm() {
    const token = tokenRef.current;
    if (!token || submitting) return;
    setSubmitting(true);
    try {
      setConfirmation(await post<Confirmation>("/api/email-actions/confirm", token));
    } catch {
      setConfirmation({ result: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  if (confirmation) {
    switch (confirmation.result) {
      case "applied":
        return (
          <Message
            title={ACTION_LABELS[confirmation.context.action].done}
            body={confirmation.context.action === "approve_asset" ? publicationApprovalScope(confirmation.context) : undefined}
            context={confirmation.context}
          />
        );
      case "stale":
        return <Message title="Esta versión ya no está vigente" body="El contenido cambió desde que se envió este correo. No se aplicó ningún cambio; revisa el correo más reciente." context={confirmation.context} />;
      case "not_actionable":
        return <Message title="Ya se tomó una decisión" body={`Estado actual: ${STATUS_LABELS[confirmation.currentStatus] ?? confirmation.currentStatus}. No se aplicó ningún cambio.`} context={confirmation.context} />;
      case "already_processed":
        return <Message title="Enlace ya utilizado" body={ALREADY_PROCESSED_BODY} context={confirmation.context} />;
      case "expired":
        return <Message title="Enlace vencido" body="Este enlace ya no es válido. No se aplicó ningún cambio." context={confirmation.context} />;
      case "failed":
        return <Message title="No se pudo completar la acción" body="No se aplicó ningún cambio." />;
      default:
        return <Message title="Enlace no válido" body="No se aplicó ningún cambio." />;
    }
  }

  if (!inspection) return <Message title="Verificando enlace…" />;

  switch (inspection.state) {
    case "ready": {
      const labels = ACTION_LABELS[inspection.context.action];
      return (
        <div className="space-y-4">
          <Message
            title={labels.question}
            body={inspection.context.action === "approve_asset" ? publicationApprovalScope(inspection.context) : undefined}
            context={inspection.context}
          />
          <p className="text-xs" style={{ color: "var(--muted)" }}>
            Nada se aplica hasta que confirmes. Esta acción solo aplica a la versión indicada.
          </p>
          <button
            type="button"
            onClick={confirm}
            disabled={submitting}
            className="rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: inspection.context.action === "reject_draft" ? "#b91c1c" : "#15803d" }}
          >
            {submitting ? "Aplicando…" : labels.button}
          </button>
        </div>
      );
    }
    case "stale":
      return <Message title="Esta versión ya no está vigente" body="El contenido cambió desde que se envió este correo. Este enlace ya no puede aplicar ninguna decisión." context={inspection.context} />;
    case "not_actionable":
      return <Message title="Ya se tomó una decisión" body={`Estado actual: ${STATUS_LABELS[inspection.currentStatus] ?? inspection.currentStatus}.`} context={inspection.context} />;
    case "already_processed":
      return <Message title="Enlace ya utilizado" body={ALREADY_PROCESSED_BODY} context={inspection.context} />;
    case "expired":
      return <Message title="Enlace vencido" body="Este enlace ya no es válido." context={inspection.context} />;
    case "error":
      return <Message title="No se pudo verificar el enlace" body="Intenta abrir el enlace del correo de nuevo." />;
    default:
      return <Message title="Enlace no válido" body="Abre el enlace directamente desde el correo de revisión." />;
  }
}
