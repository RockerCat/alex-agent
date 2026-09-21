-- AlexAgent — WhatsApp outbound notification provider-status diagnostics
-- (see app/api/webhooks/whatsapp/route.ts, lib/agent/whatsappWebhook.ts).
--
-- notification_outbox.status already means "the send request was
-- accepted by Meta" (see lib/agent/notifications.ts) — that existing
-- application-level retry/outbox state machine is intentionally
-- untouched here. provider_status is a separate, later-arriving signal:
-- Meta's own asynchronous delivery-status webhook callback (sent ->
-- delivered -> read, or failed), which only ever adds diagnostics to a
-- row this app already accepted — never a reinterpretation of `status`.
--
-- provider_status_at guards against Meta's documented out-of-order
-- webhook delivery: a callback older than the currently recorded one is
-- ignored rather than regressing the diagnostic state (see
-- recordProviderStatus in lib/agent/whatsappWebhook.ts).
--
-- provider_error_code/provider_error_detail hold only Meta's own short
-- numeric error code and a truncated, sanitized title/message for a
-- 'failed' callback — never a raw webhook payload dump.

alter table notification_outbox
  add column provider_status text
    check (provider_status in ('sent', 'delivered', 'read', 'failed')),
  add column provider_status_at timestamptz,
  add column provider_error_code integer,
  add column provider_error_detail text;

-- Webhook status callbacks correlate by provider_message_id only (never
-- draft/agent_run ids) — this index is what makes that lookup efficient.
create index notification_outbox_provider_message_id_idx
  on notification_outbox (provider_message_id)
  where provider_message_id is not null;
