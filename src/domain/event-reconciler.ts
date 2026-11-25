import { Config } from './config';
import { EventFeed, OperationalEvent, Segment } from './model';
import { ageMinutes, localMinutes } from './time';

export type OpState = 'ON_TIME' | 'DELAYED' | 'CANCELLED' | 'UNKNOWN' | 'CONFLICT';

export interface SegmentStatus {
  segmentId: string;
  state: OpState;
  /** true si la información de un vuelo afectado es más antigua que el umbral. */
  stale: boolean;
  /** true si el estado es UNKNOWN pero hubo información de estado (retraso/estado/cancelación) de fuentes no confiables. */
  unverifiable: boolean;
  delayMinutes: number;
  newDeparture?: string;
  gate?: string;
  basedOnEventIds: string[];
  discarded: { eventId: string; reason: string }[];
  conflictReasons: string[];
}

// Fuentes confiables y prioridad. Una fuente degradada o desconocida NUNCA entra al cálculo.
const PRIORITY: Record<string, number> = { OPS_CORE: 2, AIRPORT_FEED: 1 };

interface Normalized {
  event: OperationalEvent;
  state: 'ON_TIME' | 'DELAYED' | 'CANCELLED';
  delay: number;
}

type NormalizeResult = { n: Normalized } | { issue: string } | { ignore: true };

function normalize(e: OperationalEvent, seg: Segment): NormalizeResult {
  switch (e.type) {
    case 'DELAY': {
      if (typeof e.delayMinutes !== 'number' || !Number.isFinite(e.delayMinutes) || e.delayMinutes < 0) {
        return { issue: `DELAY_INVALID:${e.id}` };
      }
      if (e.newDeparture) {
        let expected = localMinutes(seg.date, e.newDeparture) - localMinutes(seg.date, seg.scheduledDeparture);
        if (expected < 0) expected += 1440;
        if (expected !== e.delayMinutes) return { issue: `DELAY_INCONSISTENT:${e.id}` };
      }
      return { n: { event: e, state: 'DELAYED', delay: e.delayMinutes } };
    }
    case 'CANCELLATION':
      return { n: { event: e, state: 'CANCELLED', delay: 0 } };
    case 'STATUS':
      if (e.status === 'ON_TIME' || e.status === 'SCHEDULED') return { n: { event: e, state: 'ON_TIME', delay: 0 } };
      if (e.status === 'CANCELLED') return { n: { event: e, state: 'CANCELLED', delay: 0 } };
      // Estado que no sabemos interpretar (DIVERTED, RETURNED, ...): no se asume "sin novedad".
      return { issue: `STATUS_UNSUPPORTED:${e.id}:${e.status}` };
    case 'GATE_CHANGE':
      return { ignore: true }; // informativo, se trata aparte
    default:
      return { issue: `EVENT_TYPE_UNSUPPORTED:${e.id}` };
  }
}

/**
 * Reconciliación por segmento:
 *  1. descarta fuentes degradadas / desconocidas (queda registro del motivo);
 *  2. toma el último evento de cada fuente confiable;
 *  3. si dos fuentes confiables discrepan => CONFLICT (no se adivina);
 *  4. si no hay discrepancia, manda la fuente de mayor prioridad.
 * Fail-closed: un evento malformado también produce CONFLICT, no se ignora en silencio.
 */
export function reconcileSegment(seg: Segment, feed: EventFeed, now: Date, cfg: Config): SegmentStatus {
  const mine = feed.events.filter((e) => e.segmentId === seg.id);
  const degraded = new Set(feed.sourcesDegraded);
  const available = new Set(feed.sourcesAvailable);
  const discarded: SegmentStatus['discarded'] = [];
  const conflictReasons: string[] = [];

  const trusted: OperationalEvent[] = [];
  for (const e of mine) {
    if (degraded.has(e.source)) discarded.push({ eventId: e.id, reason: 'SOURCE_DEGRADED' });
    else if (!available.has(e.source) || !Object.hasOwn(PRIORITY, e.source))
      discarded.push({ eventId: e.id, reason: 'SOURCE_NOT_TRUSTED' });
    else trusted.push(e);
  }

  const normalized: Normalized[] = [];
  for (const e of trusted) {
    const r = normalize(e, seg);
    if ('issue' in r) conflictReasons.push(r.issue);
    else if ('n' in r) normalized.push(r.n);
  }

  const latestBySource = new Map<string, Normalized>();
  for (const n of normalized) {
    const cur = latestBySource.get(n.event.source);
    const tN = Date.parse(n.event.recordedAt);
    if (Number.isNaN(tN)) { conflictReasons.push(`TIMESTAMP_INVALID:${n.event.id}`); continue; }
    const tC = cur ? Date.parse(cur.event.recordedAt) : -Infinity;
    if (tN > tC) latestBySource.set(n.event.source, n);
    else if (tN === tC && cur && (cur.state !== n.state || cur.delay !== n.delay)) {
      conflictReasons.push(`SAME_SOURCE_TIE:${n.event.source}`);
    }
  }
  const latest = [...latestBySource.values()];

  for (let i = 0; i < latest.length; i++) {
    for (let j = i + 1; j < latest.length; j++) {
      const a = latest[i];
      const b = latest[j];
      const incompatible =
        a.state !== b.state ||
        (a.state === 'DELAYED' && Math.abs(a.delay - b.delay) > cfg.delayToleranceMinutes);
      if (incompatible) conflictReasons.push(`SOURCES_DISAGREE:${a.event.source}/${b.event.source}`);
    }
  }

  // Puerta: último GATE_CHANGE de una fuente confiable, solo si es reciente.
  const gateEvent = trusted
    .filter((e) => e.type === 'GATE_CHANGE' && e.gate)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  const gate = gateEvent && ageMinutes(gateEvent.recordedAt, now) <= cfg.maxEventAgeMinutes ? gateEvent.gate : undefined;

  const base = { segmentId: seg.id, gate, discarded, conflictReasons, unverifiable: false };

  if (conflictReasons.length) {
    return { ...base, state: 'CONFLICT', stale: false, delayMinutes: 0, basedOnEventIds: latest.map((l) => l.event.id) };
  }
  if (latest.length === 0) {
    // Sin eventos de estado de fuentes confiables. Si alguna fuente no confiable sí reportó estado,
    // hay una señal que no podemos verificar: no se asume "sin novedad" (fail-closed => humano).
    // Si no hubo ningún evento de estado, no hay indicio de modificación.
    const unverifiable = mine.some((e) => e.type !== 'GATE_CHANGE' && !trusted.includes(e));
    return { ...base, unverifiable, state: 'UNKNOWN', stale: false, delayMinutes: 0, basedOnEventIds: [] };
  }
  const best = latest.sort((a, b) => PRIORITY[b.event.source] - PRIORITY[a.event.source])[0];
  const disrupted = best.state !== 'ON_TIME';
  return {
    ...base,
    state: best.state,
    stale: disrupted && ageMinutes(best.event.recordedAt, now) > cfg.maxEventAgeMinutes,
    delayMinutes: best.delay,
    newDeparture: best.event.newDeparture,
    basedOnEventIds: latest.map((l) => l.event.id),
  };
}
