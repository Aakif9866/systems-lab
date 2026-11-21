import type { Metadata } from "next";
import { Diagram } from "@/components/Diagram";
import { List, Section, hueVar } from "@/components/ui";
import { archDiagram, contract, envelope, layers, lifecycle, security, wire } from "@/lib/platform";

export const metadata: Metadata = { title: "Architecture", description: "The five-layer Systems Lab platform, its execution contract and security model." };

export default function Architecture() {
  return (
    <div style={hueVar("cyan")}>
      <header className="pt-12">
        <p className="text-sm text-muted">~/architecture</p>
        <h1 className="mt-3 text-3xl lg:text-5xl text-heading font-medium tracking-tight">The full platform</h1>
        <p className="mt-4 max-w-3xl text-lg">How the production Systems Lab runs real C++ and Rust systems safely for anyone on the internet — five layers, one execution contract, isolation designed in from day one.</p>
      </header>

      <Section id="map" label="map" title="System context" intro={<p>Click any box. Follow a request from the browser to an isolated system container.</p>}>
        <Diagram nodes={archDiagram.nodes} edges={archDiagram.edges} title="Systems Lab platform architecture" />
      </Section>

      <Section id="layers" label="layers" title="Five layers, clearly separated">
        <ol className="space-y-10">
          {layers.map((l) => (
            <li key={l.n} className="grid grid-cols-1 gap-4 md:grid-cols-[12rem_1fr]">
              <div>
                <p className="text-hue tabular-nums">L{l.n}</p>
                <p className="text-heading text-lg">{l.name}</p>
                <p className="text-xs text-muted mt-1">{l.where}</p>
              </div>
              <div className="space-y-3">
                <p className="text-sm text-muted">{l.tech}</p>
                <List items={l.does} />
                <p className="text-sm"><span className="text-error">rule · </span>{l.never}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="contract" label="contract" title="One execution contract for ten different systems" intro={<p>Standardize the outside, keep the inside honest. Every system ships one binary in its own image and speaks the same protocol, whatever its language — so the control plane needs zero project-specific code.</p>}>
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-muted mb-2">conceptual lifecycle (Rust)</p>
            <pre className="bg-surface rounded-sm p-4 text-xs overflow-x-auto text-heading">{contract}</pre>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted mb-2">event envelope — every visualization is driven by these</p>
            <pre className="bg-surface rounded-sm p-4 text-xs overflow-x-auto text-heading">{envelope}</pre>
          </div>
        </div>
        <dl className="mt-8 space-y-2 text-sm [overflow-wrap:anywhere]">
          {wire.map((w) => <div key={w.ch} className="grid grid-cols-[5rem_1fr] gap-3"><dt className="text-hue">{w.ch}</dt><dd>{w.what}</dd></div>)}
        </dl>
        <p className="mt-6 text-sm text-muted">The mini engines on this site emit the same envelope — open any playground&apos;s event log.</p>
      </Section>

      <Section id="lifecycle" label="lifecycle" title="Execution lifecycle">
        <ol className="flex flex-wrap items-center gap-2 text-sm">
          {lifecycle.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              {i > 0 && <span className="text-dim" aria-hidden="true">→</span>}
              <span className={`bg-surface px-3 py-1.5 rounded-sm ${["failed", "timed out"].includes(s) ? "text-error" : s === "running" ? "text-hue" : "text-heading"}`}>{s}</span>
            </li>
          ))}
        </ol>
        <p className="mt-6 max-w-3xl">User configures → control plane validates against the system&apos;s manifest → agent provisions an isolated container → the system starts and emits events → the agent forwards telemetry → the browser visualizes it live → stop or timeout releases everything and stores the results. A heartbeat lease means a closed tab never leaves a workload running.</p>
      </Section>

      <Section id="security" label="security" title="Security model">
        <div className="max-w-3xl"><List items={security} marker="◆" /></div>
      </Section>

      <Section id="deploy" label="deploy" title="Deployment">
        <div className="grid grid-cols-1 gap-x-10 gap-y-3 sm:grid-cols-2 text-sm max-w-3xl">
          {[["frontend", "Vercel"], ["control plane", "dedicated Linux compute"], ["systems", "isolated Docker containers / dedicated hosts"], ["database", "managed PostgreSQL"], ["observability", "Prometheus + Grafana + OpenTelemetry"], ["CI/CD", "GitHub Actions, per-system path filters"]].map(([k, v]) => (
            <div key={k}><span className="text-muted">{k} · </span><span className="text-heading">{v}</span></div>
          ))}
        </div>
      </Section>
    </div>
  );
}
