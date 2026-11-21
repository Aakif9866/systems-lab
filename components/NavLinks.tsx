"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const nav = [
  { href: "/", label: "~/systems", match: (p: string) => p === "/" || p.startsWith("/projects") },
  { href: "/architecture", label: "~/architecture", match: (p: string) => p.startsWith("/architecture") },
  { href: "/roadmap", label: "~/roadmap", match: (p: string) => p.startsWith("/roadmap") },
];

export function NavLinks() {
  const path = usePathname().replace(/\.html$/, "");
  return (
    <nav aria-label="main" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
      {nav.map((n) => {
        const active = n.match(path);
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={`py-2 transition-colors duration-150 ${active ? "text-heading underline decoration-[var(--accent)] decoration-2 underline-offset-[6px]" : "text-muted hover:text-heading"}`}
          >
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
