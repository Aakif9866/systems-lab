import Link from "next/link";
import { Caret, hueVar } from "@/components/ui";
import { projects } from "@/lib/projects";

export default function NotFound() {
  return (
    <section className="pt-16">
      <p className="text-sm text-muted">~/404</p>
      <h1 className="mt-4 text-3xl lg:text-5xl text-heading font-medium tracking-tight">
        <span className="text-error">$</span> cd: no such page
        <Caret />
      </h1>
      <p className="mt-6 max-w-2xl">That path doesn&apos;t exist (404 not found). Pick a system, or head back to the list.</p>
      <p className="mt-6">
        <Link href="/" className="text-heading hover:text-accent">← back to ~/systems</Link>
      </p>
      <ul className="mt-10 grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 text-sm">
        {projects.map((p) => (
          <li key={p.slug} style={hueVar(p.hue)}>
            <Link href={`/projects/${p.slug}`} className="hover:text-heading py-1 inline-block">
              <span className="text-hue tabular-nums">{p.num}</span> {p.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
