import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Diagram } from "@/components/Diagram";
import { PlaygroundLoader } from "@/components/PlaygroundLoader";
import { Honesty } from "@/components/lab/kit";
import { Badge, Dots, List, Section, hueVar } from "@/components/ui";
import { bySlug, projects } from "@/lib/projects";

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const p = bySlug((await params).slug);
  return p ? { title: p.name, description: p.tagline } : {};
}

const toc = ["overview", "playground", "architecture", "internals", "experiments", "metrics", "scope", "build"];

export default async function ProjectPage({ params }: PageProps<"/projects/[slug]">) {
  const { slug } = await params;
  const p = bySlug(slug);
  if (!p) notFound();
  const i = projects.indexOf(p);
  const prev = projects[(i + projects.length - 1) % projects.length];
  const next = projects[(i + 1) % projects.length];

  return (
    <article style={hueVar(p.hue)}>
      <div className="h-px w-full" style={{ background: "var(--hue)" }} />
      <header className="mt-10">
        <p className="text-sm text-muted">
          <Link href="/" className="hover:text-heading">~/systems</Link> / <span className="text-hue">{p.num}</span>
        </p>
        <h1 className="mt-3 text-3xl lg:text-5xl text-heading font-medium tracking-tight">{p.name}</h1>
        <p className="mt-4 max-w-3xl text-lg">{p.tagline}</p>
        <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span><span className="text-muted">production lang </span><span className="text-heading">{p.lang}</span></span>
          <span><span className="text-muted">difficulty </span><Dots n={p.difficulty} /></span>
          <span><span className="text-muted">effort </span><span className="text-heading">{p.effort}</span></span>
          <Badge>{p.mini.badge}</Badge>
        </div>
        <nav aria-label="sections" className="mt-8 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {toc.map((t) => <a key={t} href={`#${t}`} className="text-muted hover:text-hue py-1">#{t}</a>)}
        </nav>
      </header>

      <Section id="overview" label="overview" title="What it is, simply">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
          <div className="space-y-4">
            <p className="text-heading">{p.overview.what}</p>
            <p>{p.overview.why}</p>
            <div className="flex flex-wrap gap-2">{p.concepts.map((c) => <Badge key={c} tone="muted">{c}</Badge>)}</div>
          </div>
          <div className="space-y-6 text-sm">
            <div><p className="text-muted mb-2">used in the real world</p><List items={p.overview.usedIn} /></div>
            <div><p className="text-muted mb-2">alternatives</p><List items={p.overview.alternatives} /></div>
            <div><p className="text-muted mb-2">limitations</p><List items={p.overview.limits} marker="!" /></div>
          </div>
        </div>
      </Section>

      <Section id="playground" label="playground" title="Run the mini engine" intro={<p>This is real code executing in your browser tab — not an animation. Change things, break things, watch the events.</p>}>
        <div className="mb-8"><Honesty real={p.mini.real} simulated={p.mini.simulated} /></div>
        <PlaygroundLoader slug={p.slug} />
      </Section>

      <Section id="architecture" label="architecture" title="How the pieces fit" intro={<p>Each box is a real component of the mini engine; click it to see what it does and which file implements it.</p>}>
        <Diagram nodes={p.diagram.nodes} edges={p.diagram.edges} title={`${p.name} architecture`} />
      </Section>

      <Section id="internals" label="internals" title="Learn the internals">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-2">
          {p.internals.map((c, k) => (
            <div key={c.title}>
              <p className="text-heading"><span className="text-hue">{String(k + 1).padStart(2, "0")}</span> {c.title}</p>
              <p className="mt-2 text-heading/90 italic">{c.simple}</p>
              <p className="mt-2 text-sm">{c.detail}</p>
              <p className="mt-2 text-sm"><span className="text-error">common mistake · </span>{c.mistake}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="experiments" label="experiments" title="Guided experiments" intro={<p>Run these in the playground above. Write down what you expect before you start.</p>}>
        <ol className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {p.experiments.map((e, k) => (
            <li key={e.title}>
              <p className="text-heading"><span className="text-hue">E{k + 1}</span> {e.title}</p>
              <dl className="mt-2 text-sm space-y-1.5">
                <div><dt className="inline text-muted">objective · </dt><dd className="inline">{e.objective}</dd></div>
                <div><dt className="inline text-muted">do · </dt><dd className="inline">{e.steps}</dd></div>
                <div><dt className="inline text-muted">expect · </dt><dd className="inline">{e.expect}</dd></div>
              </dl>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="metrics" label="metrics" title="What gets measured">
        <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2"><List items={p.metrics} marker="▪" /></div>
        <p className="mt-4 text-sm text-muted">In the playground these come from the running engine. Time-based numbers are labelled ticks (simulated clock) or ms (measured in your browser).</p>
      </Section>

      <Section id="scope" label="scope" title="Full specification vs this mini version">
        <ul className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3 text-sm">
          {p.scope.map((s) => <li key={s}><span className="text-hue">□</span> {s}</li>)}
        </ul>
        <p className="mt-4 text-sm text-muted">The production {p.lang} implementation targets every item above. The playground&apos;s real/simulated split is listed under ~/playground.</p>
      </Section>

      <Section id="build" label="build" title={`How the ${p.lang} version gets built`}>
        <ol className="space-y-4 max-w-3xl">
          {p.build.map((b, k) => (
            <li key={b.step} className="flex gap-4">
              <span className="text-hue tabular-nums shrink-0">{String(k + 1).padStart(2, "0")}</span>
              <span><span className="text-heading">{b.step}</span> — {b.detail}</span>
            </li>
          ))}
        </ol>
        <div className="mt-6 flex flex-wrap gap-2">{p.stack.map((s) => <Badge key={s} tone="muted">{s}</Badge>)}</div>
      </Section>

      <nav aria-label="more systems" className="mt-24 flex justify-between gap-4 text-sm">
        <Link href={`/projects/${prev.slug}`} className="text-muted hover:text-heading py-2">← {prev.num} {prev.name}</Link>
        <Link href={`/projects/${next.slug}`} className="text-muted hover:text-heading py-2 text-right">{next.num} {next.name} →</Link>
      </nav>
    </article>
  );
}
