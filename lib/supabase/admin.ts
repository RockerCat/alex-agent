import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/lib/types/database";

let cached: SupabaseClient<Database> | null = null;

/**
 * Privileged, server-only Supabase client using the service-role key.
 * Never import this from a client component or route handler that could
 * leak the key to the browser. All budget/concurrency/persistence
 * enforcement in this app happens through this client so it is
 * authoritative regardless of what the UI shows.
 */
export function supabaseAdmin(): SupabaseClient<Database> {
  if (cached) return cached;
  cached = createClient<Database>(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
