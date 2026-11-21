"use client";
import dynamic from "next/dynamic";

const loading = () => <p className="text-muted text-sm">booting engine<span className="caret" aria-hidden="true" /></p>;

// Each engine + UI is code-split so a project page only loads its own playground.
const playgrounds: Record<string, React.ComponentType> = {
  "distributed-database": dynamic(() => import("./playgrounds/DistributedDatabase"), { ssr: false, loading }),
  "container-runtime": dynamic(() => import("./playgrounds/ContainerRuntime"), { ssr: false, loading }),
  compiler: dynamic(() => import("./playgrounds/Compiler"), { ssr: false, loading }),
  "redis-engine": dynamic(() => import("./playgrounds/RedisEngine"), { ssr: false, loading }),
  "async-runtime": dynamic(() => import("./playgrounds/AsyncRuntime"), { ssr: false, loading }),
  "message-broker": dynamic(() => import("./playgrounds/MessageBroker"), { ssr: false, loading }),
  "memory-allocator": dynamic(() => import("./playgrounds/MemoryAllocator"), { ssr: false, loading }),
  "query-engine": dynamic(() => import("./playgrounds/QueryEngine"), { ssr: false, loading }),
  "reverse-proxy": dynamic(() => import("./playgrounds/ReverseProxy"), { ssr: false, loading }),
  "version-control": dynamic(() => import("./playgrounds/VersionControl"), { ssr: false, loading }),
};

export function PlaygroundLoader({ slug }: { slug: string }) {
  const P = playgrounds[slug];
  return P ? <P /> : <p className="text-error">no playground for {slug}</p>;
}
