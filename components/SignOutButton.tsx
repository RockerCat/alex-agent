"use client";

import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function SignOutButton() {
  const router = useRouter();

  return (
    <button
      type="button"
      className="text-sm px-2.5 py-1.5 rounded-md whitespace-nowrap"
      style={{ color: "var(--muted)" }}
      onClick={async () => {
        await supabaseBrowser().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
