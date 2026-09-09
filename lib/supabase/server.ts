import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";
import type { Database } from "@/lib/types/database";

/**
 * Session-aware Supabase client for use in server components, route
 * handlers, and server actions. Uses the anon key + the caller's auth
 * cookies — this is for identifying *who* is calling, not for privileged
 * data access. Privileged reads/writes go through lib/supabase/admin.ts.
 */
export async function supabaseServer() {
  const cookieStore = await cookies();

  return createServerClient<Database>(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component render — middleware refreshes
          // the session cookie instead. Safe to ignore.
        }
      },
    },
  });
}

export async function requireSession() {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    return null;
  }

  const ownerEmail = env.ownerEmail();
  if (ownerEmail && data.user.email !== ownerEmail) {
    return null;
  }

  return data.user;
}
