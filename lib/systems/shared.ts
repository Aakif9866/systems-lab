// Shared helpers for every mini engine. No React, no deps — runs in the browser and under `node --test`.

/** Execution event envelope from the Systems Lab architecture spec (prompt2 §3). */
export type LabEvent = {
  execution_id: string;
  project: string;
  event_type: string;
  timestamp: string;
  source: string;
  payload: Record<string, unknown>;
  seq: number;
};

let execCounter = 0;

export class Emitter {
  readonly project: string;
  readonly executionId: string;
  events: LabEvent[] = [];
  limit: number;
  private seq = 0;

  constructor(project: string, limit = 400) {
    this.project = project;
    this.limit = limit;
    this.executionId = `exec-${Date.now().toString(36)}-${++execCounter}`;
  }

  emit(eventType: string, source: string, payload: Record<string, unknown> = {}): void {
    this.events.push({
      execution_id: this.executionId,
      project: this.project,
      event_type: eventType,
      timestamp: new Date().toISOString(),
      source,
      payload,
      seq: ++this.seq,
    });
    // Evict the oldest event of a noisy type so rare, important events (elections, OOM kills,
    // breaker trips) survive floods of routine ones. ponytail: O(limit) per emit, fine at a few hundred.
    if (this.events.length > this.limit) {
      const counts = new Map<string, number>();
      for (const e of this.events) counts.set(e.event_type, (counts.get(e.event_type) ?? 0) + 1);
      const i = this.events.findIndex((e) => counts.get(e.event_type)! > this.limit / 8);
      this.events.splice(i >= 0 ? i : 0, 1);
    }
  }

  clear(): void {
    this.events = [];
  }
}

/** Seeded PRNG (mulberry32) so simulations and tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash. */
export function fnv1a(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
