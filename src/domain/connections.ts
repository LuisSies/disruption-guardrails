import { Config } from './config';
import { SegmentStatus } from './event-reconciler';
import { localMinutes } from './time';
import { Segment } from './model';

export interface ConnectionRisk {
  fromSegmentId: string;
  toSegmentId: string;
  airport: string;
  finalDestination: string;
  /** minutos locales (zona del aeropuerto de conexión) */
  estimatedArrivalLocal: number;
  nextDepartureLocal: number;
  slackMinutes: number;
  minRequiredMinutes: number;
  /** Es una PREDICCIÓN (propaga el retraso 1:1), no un hecho confirmado. */
  status: 'OK' | 'MISSED_PREDICTED' | 'INBOUND_CANCELLED';
}

export function computeConnections(segments: Segment[], statuses: SegmentStatus[], cfg: Config): ConnectionRisk[] {
  const byId = new Map(statuses.map((s) => [s.segmentId, s]));
  const out: ConnectionRisk[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    if (a.destination !== b.origin) continue;
    const sa = byId.get(a.id);
    const sb = byId.get(b.id);
    const delayA = sa?.state === 'DELAYED' ? sa.delayMinutes : 0;
    const delayB = sb?.state === 'DELAYED' ? sb.delayMinutes : 0;
    const overnight = a.scheduledArrival < a.scheduledDeparture ? 1 : 0;
    const arr = localMinutes(a.date, a.scheduledArrival, overnight) + delayA;
    const dep = localMinutes(b.date, b.scheduledDeparture) + delayB;
    const slack = dep - arr;
    const status: ConnectionRisk['status'] =
      sa?.state === 'CANCELLED' ? 'INBOUND_CANCELLED' : slack < cfg.minConnectionMinutes ? 'MISSED_PREDICTED' : 'OK';
    out.push({
      fromSegmentId: a.id,
      toSegmentId: b.id,
      airport: a.destination,
      finalDestination: b.destination,
      estimatedArrivalLocal: arr,
      nextDepartureLocal: dep,
      slackMinutes: slack,
      minRequiredMinutes: cfg.minConnectionMinutes,
      status,
    });
  }
  return out;
}
