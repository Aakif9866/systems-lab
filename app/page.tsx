import Link from "next/link";
import { Reveal } from "@/components/Reveal";
import { Badge, Caret, Dots, hueVar } from "@/components/ui";
import { paths, thisSite } from "@/lib/platform";
import { bySlug, projects } from "@/lib/projects";

const concepts = new Set(projects.flatMap((p) => p.concepts)).size;

export default function Home() {
  return (
    <>
      <section className="pt-12 sm:pt-20">
        <p className="text-sm text-muted">~/systems</p>
        <h1 className="mt-4 text-3xl lg:text-6xl text-heading font-medium tracking-tight leading-tight">
          <span className="text-accent">$</span> systems-lab --list
          <Caret />
        </h1>
        <p className="mt-6 max-w-2xl text-lg">
          Ten systems every backend runs on — a distributed database, a compiler, a container runtime, an async scheduler and more — explained from first principles, diagrammed from real code, and <span className="text-heading">running as mini engines in your browser</span>.
        </p>
        <dl className="mt-12 flex flex-wrap gap-x-14 gap-y-6">
          {[["10", "systems"], ["2", "production languages · C++ / Rust"], [String(concepts), "concepts"], ["77", "engine tests passing"]].map(([n, l]) => (
            <div key={l}>
              <dd className="text-4xl text-heading tabular-nums">{n}</dd>
              <dt className="text-xs text-muted mt-1">{l}</dt>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="list-h" className="mt-24">
        <h2 id="list-h" className="text-sm text-muted">~/systems — pick one</h2>
        <ol className="mt-4">
          {projects.map((p, i) => (
            <li key={p.slug} style={hueVar(p.hue)}>
              <Reveal delay={i * 40}>
                <Link href={`/projects/${p.slug}`} className="group grid grid-cols-[3rem_1fr] md:grid-cols-[3rem_minmax(0,1.3fr)_minmax(0,1fr)_7rem_6rem] gap-x-4 gap-y-1 items-baseline py-5 border-t border-border hover:bg-surface transition-colors duration-150 px-2 -mx-2 rounded-sm">
                  <span className="text-hue tabular-nums">{p.num}</span>
                  <span>
                    <span className="text-heading text-lg group-hover:text-hue transition-colors">{p.name}</span>
                    <span className="block text-sm mt-1">{p.tagline}</span>
                  </span>
                  <span className="col-start-2 md:col-start-auto text-xs text-muted">{p.concepts.slice(0, 4).join(" · ")}</span>
                  <span className="col-start-2 md:col-start-auto text-sm"><span className="text-heading">{p.lang}</span> <span className="text-muted">· {p.effort}</span></span>
                  <span className="col-start-2 md:col-start-auto text-sm"><Dots n={p.difficulty} /></span>
                </Link>
              </Reveal>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="paths-h" className="mt-24">
        <p className="text-sm text-muted">~/paths</p>
        <h2 id="paths-h" className="mt-1 text-2xl text-heading font-medium">Learning paths</h2>
        <div className="mt-8 grid gap-10 md:grid-cols-2">
          {paths.map((path) => (
            <Reveal key={path.name}>
              <p className="text-heading">{path.name}</p>
              <p className="mt-1 text-sm">{path.why}</p>
              <ol className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                {path.slugs.map((s, k) => {
                  const p = bySlug(s)!;
                  return (
                    <li key={s} className="flex items-center gap-2" style={hueVar(p.hue)}>
                      {k > 0 && <span className="text-dim" aria-hidden="true">→</span>}
                      <Link href={`/projects/${s}`} className="text-hue hover:underline py-1">{p.name}</Link>
                    </li>
                  );
                })}
              </ol>
            </Reveal>
          ))}
        </div>
      </section>

      <section aria-labelledby="how-h" className="mt-24 grid gap-10 lg:grid-cols-2">
        <Reveal>
          <p className="text-sm text-muted">~/how-it-works</p>
          <h2 id="how-h" className="mt-1 text-2xl text-heading font-medium">{thisSite.title}</h2>
          <ul className="mt-6 space-y-3">
            {thisSite.points.map((t) => <li key={t} className="flex gap-3"><span className="text-accent" aria-hidden="true">›</span><span>{t}</span></li>)}
          </ul>
        </Reveal>
        <Reveal delay={80}>
          <p className="text-sm text-muted">~/next</p>
          <div className="mt-8 space-y-6">
            <Link href="/architecture" className="block group">
              <span className="text-heading group-hover:text-accent transition-colors">→ the full platform architecture</span>
              <span className="block text-sm mt-1">Five layers, the execution contract every system speaks, the security model.</span>
            </Link>
            <Link href="/roadmap" className="block group">
              <span className="text-heading group-hover:text-accent transition-colors">→ the build roadmap</span>
              <span className="block text-sm mt-1">Eight phases from empty repo to ten deployed C++/Rust systems.</span>
            </Link>
            <div className="flex flex-wrap gap-2"><Badge tone="muted">Next.js</Badge><Badge tone="muted">TypeScript</Badge><Badge tone="muted">Tailwind</Badge><Badge tone="muted">no backend</Badge></div>
          </div>
        </Reveal>
      </section>
    </>
  );
}
