"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { SignOutButton } from "@/components/SignOutButton";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/approvals", label: "Approvals" },
  { href: "/questions", label: "Questions" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b" style={{ borderColor: "var(--border)", background: "var(--card)" }}>
      <div className="mx-auto max-w-4xl px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold tracking-tight whitespace-nowrap">AlexAgent</span>
          <span className="text-xs rounded px-1.5 py-0.5 whitespace-nowrap" style={{ background: "var(--accent)", color: "#0f172a" }}>
            SolarDesk
          </span>
        </div>
        <nav className="flex items-center gap-1 overflow-x-auto">
          {LINKS.map((link) => {
            const active = pathname?.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm px-2.5 py-1.5 rounded-md whitespace-nowrap"
                style={{
                  background: active ? "var(--accent)" : "transparent",
                  color: active ? "#0f172a" : "var(--foreground)",
                  fontWeight: active ? 600 : 400,
                }}
              >
                {link.label}
              </Link>
            );
          })}
          <SignOutButton />
        </nav>
      </div>
    </header>
  );
}
