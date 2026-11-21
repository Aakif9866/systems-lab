import type { Metadata } from "next";
import Link from "next/link";
import { List, Section, hueVar } from "@/components/ui";
import { definitionOfDone, paths, phases } from "@/lib/platform";
import { bySlug, projects } from "@/lib/projects";

export const metadata: Metadata = { title: "Roadmap", description: "Eight phases from an empty repository to ten deployed C++/Rust systems." };

export default function Roadmap() {
  return (
    <div style={hueVar("amber")}>
      <header className="pt-12">
        <p className="text-sm text-muted">~/roadmap</p>
        <h1 className="mt-3 text-3xl lg:text-5xl text-heading font-medium tracking-tight">How it gets built</h1>
        <p className="mt-4 max-w-3xl text-lg">Foundation first, one system end-to-end, then the other nine on the proven path. Never all ten at once.</p>
      </header>

      <Section id="phases" label="phases" title="Eight phases">
        <ol className="relative">
          {phases.map((p) => (
            <li key={p.n} className="grid grid-cols-[3rem_1fr] gap-4 pb-8">
              <span className="text-hue tabular-nums text-lg">{String(p.n).padStart(2, "0")}</span>
              <div>
                <p className="text-heading">{p.name}</p>
                <p className="mt-1">{p.what}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="status" label="status" title="Where each system stands">
        <div className="overflow-x-auto">
          <table className="text-sm w-full min-w-[40rem]">
            <thead className="text-xs text-muted text-left"><tr>{["#", "system", "lang", "effort", "mini engine (this site)", "production"].map((h) => <th key={h} className="font-normal py-2 pr-4">{h}</th>)}</tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.slug} className="border-t border-border" style={hueVar(p.hue)}>
                  <td className="py-2 pr-4 text-hue tabular-nums">{p.num}</td>
                  <td className="pr-4"><Link href={`/projects/${p.slug}`} className="text-heading hover:text-hue">{p.name}</Link></td>
                  <td className="pr-4">{p.lang}</td>
                  <td className="pr-4 text-muted">{p.effort}</td>
                  <td className="pr-4 text-hue">✓ running · tested</td>
                  <td className="text-muted">planned</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="done" label="definition-of-done" title="A system counts as done when">
        <div className="max-w-3xl"><List items={definitionOfDone} marker="□" /></div>
      </Section>

      <Section id="paths" label="paths" title="Learning paths">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-2">
          {paths.map((path) => (
            <div key={path.name}>
              <p className="text-heading">{path.name}</p>
              <p className="text-sm mt-1">{path.why}</p>
              <p className="mt-2 text-sm">{path.slugs.map((s) => bySlug(s)!.name).join(" → ")}</p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
