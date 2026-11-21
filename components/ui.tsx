import type { CSSProperties, ReactNode } from "react";
import type { Hue } from "@/lib/projects";
import { Reveal } from "./Reveal";

export const hueVar = (h: Hue) => ({ "--hue": `var(--h-${h})` }) as CSSProperties;

export function Section({ id, label, title, children, intro }: { id: string; label: string; title?: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="mt-20 scroll-mt-8">
      <Reveal>
        <p className="text-sm text-hue">~/{label}</p>
        <h2 id={`${id}-h`} className="mt-1 text-xl sm:text-2xl text-heading font-medium">
          {title ?? label}
        </h2>
        {intro && <div className="mt-3 max-w-3xl text-text">{intro}</div>}
        <div className="mt-6">{children}</div>
      </Reveal>
    </section>
  );
}

export function Caret() {
  return <span className="caret" aria-hidden="true" />;
}

export function Badge({ children, tone = "hue" }: { children: ReactNode; tone?: "hue" | "muted" | "warn" }) {
  const cls = tone === "hue" ? "text-hue" : tone === "warn" ? "text-error" : "text-muted";
  return <span className={`inline-block bg-surface px-2 py-0.5 rounded-sm text-xs ${cls}`}>{children}</span>;
}

export function Dots({ n, of = 5 }: { n: number; of?: number }) {
  return (
    <span aria-label={`difficulty ${n} of ${of}`} className="tracking-widest">
      <span className="text-hue">{"■".repeat(n)}</span>
      <span className="text-dim">{"■".repeat(of - n)}</span>
    </span>
  );
}

export function List({ items, marker = "›" }: { items: ReactNode[]; marker?: string }) {
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-3">
          <span className="text-hue shrink-0" aria-hidden="true">
            {marker}
          </span>
          <span>{it}</span>
        </li>
      ))}
    </ul>
  );
}
