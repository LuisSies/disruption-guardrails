import { Config, DEFAULT_CONFIG } from './config';
import { ConnectionRisk, computeConnections } from './connections';
import { SegmentStatus, reconcileSegment } from './event-reconciler';
import { EvaluatedOption, evaluateOptions } from './options-evaluator';
import { Entitlement, Facts, evaluatePolicy } from './policy-engine';
import { ageMinutes, formatLocal } from './time';
import { EventFeed, OptionSet, Policy, ReferenceData, Result, Trip } from './model';

export type Outcome = 'NO_ACTION' | 'INFORM_ONLY' | 'INFORM_AND_RECOMMEND' | 'HUMAN_REVIEW';
export type ReasonCode =
  | 'TRIP_UNAVAILABLE' | 'TRIP_INCOMPLETE' | 'EVENTS_UNAVAILABLE' | 'EVENTS_FEED_STALE'
  | 'SOURCE_CONFLICT' | 'STALE_EVENTS' | 'POLICY_UNAVAILABLE' | 'POLICY_INVALID'
  | 'POLICY_UNEVALUABLE' | 'HUMAN_APPROVAL_REQUIRED' | 'OPTIONS_UNAVAILABLE'
  | 'NO_OFFERABLE_OPTION' | 'INTERNAL_INCONSISTENCY' | 'NO_TRUSTED_SOURCE';
export type ModificationKind = 'CANCELLATION' | 'SIGNIFICANT_DELAY' | 'CONNECTION_AT_RISK';
export type Scenario = 'DELAY' | 'CANCELLATION';

export interface AssessmentInput {
  bookingId: string;
  now: Date;
  trip: Result<Trip>;
  events: Result<EventFeed>;
  policy: Result<Policy>;
  options: Result<OptionSet>;
  reference: ReferenceData;
  request?: { compensationRequested?: boolean };
  config?: Partial<Config>;
}

export interface PlannedAction {
  tool: 'create_human_case' | 'notify_passenger';
  /** Un notify de handoff solo se ejecuta si el caso humano se creó. */
  after?: 'create_human_case';
  payload: Record<string, unknown>;
}

export interface Communication {
  /** NONE: no decir nada. FACTS_ONLY: hechos validados, sin opciones ni promesas. FULL: hechos + derecho + opciones. */
  level: 'NONE' | 'FACTS_ONLY' | 'FULL';
  templateId?: 'DISRUPTION_INFO' | 'DISRUPTION_FACTS_HANDOFF' | 'DISRUPTION_WITH_OPTIONS';
  policyRef?: string; // notify_passenger rechaza (422) contenido sin policy_ref
  params?: Record<string, unknown>;
}

export interface SegmentFacts {
  segmentId: string;
  flightNumber: string;
  state: SegmentStatus['state'];
  delayMinutes: number;
  newDeparture?: string;
  gate?: string;
  stale: boolean;
}

export interface Assessment {
  bookingId: string;
  outcome: Outcome;
  reasons: ReasonCode[];
  modification: { relevant: boolean; kinds: ModificationKind[]; segments: SegmentFacts[]; connections: ConnectionView[] };
  entitlements: Entitlement[];
  options: EvaluatedOption[];
  communication: Communication;
  plannedActions: PlannedAction[];
  humanCase?: { reason: string; priority: 'HIGH' | 'NORMAL'; evidence: Record<string, unknown> };
  audit: {
    evaluatedAt: string;
    policyVersion?: string;
    ruleResults?: Record<string, unknown>;
    discardedEvents: { eventId: string; reason: string }[];
    conflictReasons: string[];
    internalError?: string;
  };
}

export interface ConnectionView {
  fromSegmentId: string;
  toSegmentId: string;
  status: ConnectionRisk['status'];
  slackMinutes: number;
  estimatedArrivalLocal: string;
}

// ---------- análisis compartido (también lo usa el servicio para elegir escenario) ----------

interface Analysis {
  statuses: SegmentStatus[];
  connections: ConnectionRisk[];
  kinds: ModificationKind[];
}

function analyze(trip: Trip, feed: EventFeed, now: Date, cfg: Config): Analysis {
  const statuses = trip.segments.map((s) => reconcileSegment(s, feed, now, cfg));
  const connections = computeConnections(trip.segments, statuses, cfg);
  const kinds: ModificationKind[] = [];
  if (statuses.some((s) => s.state === 'CANCELLED')) kinds.push('CANCELLATION');
  if (statuses.some((s) => s.state === 'DELAYED' && s.delayMinutes >= cfg.relevantDelayMinutes)) kinds.push('SIGNIFICANT_DELAY');
  if (connections.some((c) => c.status !== 'OK')) kinds.push('CONNECTION_AT_RISK');
  return { statuses, connections, kinds };
}

/** Qué política pedir. null => no hay modificación relevante (o no se puede determinar). */
export function detectScenario(
  trip: Trip, feed: EventFeed, now: Date, config: Partial<Config> = {},
): Scenario | null {
  try {
    const { kinds, statuses } = analyze(trip, feed, now, { ...DEFAULT_CONFIG, ...config });
    if (statuses.some((s) => s.state === 'CONFLICT')) return null;
    if (kinds.includes('CANCELLATION')) return 'CANCELLATION';
    return kinds.length ? 'DELAY' : null;
  } catch {
    return null;
  }
}

// ---------- resolver principal (función pura: mismos inputs => misma decisión) ----------

export function assessDisruption(input: AssessmentInput): Assessment {
  const cfg = { ...DEFAULT_CONFIG, ...input.config };
  try {
    return compute(input, cfg);
  } catch (err) {
    return humanOnly(input, ['INTERNAL_INCONSISTENCY'], { internalError: String((err as Error).message).slice(0, 120) });
  }
}

function emptyAudit(now: Date): Assessment['audit'] {
  return { evaluatedAt: now.toISOString(), discardedEvents: [], conflictReasons: [] };
}

function humanOnly(
  input: AssessmentInput, reasons: ReasonCode[], extra: Partial<Assessment['audit']> = {}, evidence: Record<string, unknown> = {},
): Assessment {
  const reason = reasons.join('+');
  return {
    bookingId: input.bookingId,
    outcome: 'HUMAN_REVIEW',
    reasons,
    modification: { relevant: false, kinds: [], segments: [], connections: [] },
    entitlements: [],
    options: [],
    communication: { level: 'NONE' },
    plannedActions: [{ tool: 'create_human_case', payload: { reason, evidence: { bookingId: input.bookingId, reasons, ...evidence } } }],
    humanCase: { reason, priority: 'NORMAL', evidence: { bookingId: input.bookingId, reasons, ...evidence } },
    audit: { ...emptyAudit(input.now), ...extra },
  };
}

function compute(input: AssessmentInput, cfg: Config): Assessment {
  const { now, bookingId } = input;

  // 1) Reserva
  if (!input.trip.ok) return humanOnly(input, ['TRIP_UNAVAILABLE']);
  const trip = input.trip.data;
  const blocking = trip.missingFields.filter((f) => !cfg.nonBlockingMissingFields.includes(f));
  if (!trip.segments?.length || !trip.passengers?.length || blocking.length) {
    return humanOnly(input, ['TRIP_INCOMPLETE'], {}, { missingFields: blocking });
  }

  // 2) Eventos operacionales
  if (!input.events.ok) return humanOnly(input, ['EVENTS_UNAVAILABLE']);
  const feed = input.events.data;
  if (ageMinutes(feed.retrievedAt, now) * 60 > cfg.maxFeedAgeSeconds) return humanOnly(input, ['EVENTS_FEED_STALE']);

  const { statuses, connections, kinds } = analyze(trip, feed, now, cfg);
  const discardedEvents = statuses.flatMap((s) => s.discarded);
  const conflictReasons = statuses.flatMap((s) => s.conflictReasons);
  const flightOf = new Map(trip.segments.map((s) => [s.id, s.flightNumber]));

  const segments: SegmentFacts[] = statuses.map((s) => ({
    segmentId: s.segmentId, flightNumber: flightOf.get(s.segmentId) ?? '', state: s.state,
    delayMinutes: s.delayMinutes, newDeparture: s.newDeparture, gate: s.gate, stale: s.stale,
  }));
  const connectionViews: ConnectionView[] = connections.map((c) => ({
    fromSegmentId: c.fromSegmentId, toSegmentId: c.toSegmentId, status: c.status,
    slackMinutes: c.slackMinutes, estimatedArrivalLocal: formatLocal(c.estimatedArrivalLocal),
  }));
  const modification = { relevant: kinds.length > 0, kinds, segments, connections: connectionViews };

  if (conflictReasons.length) {
    return { ...humanOnly(input, ['SOURCE_CONFLICT'], { discardedEvents, conflictReasons }, { conflictReasons, segmentIds: statuses.filter((s) => s.state === 'CONFLICT').map((s) => s.segmentId) }), modification };
  }
  if (statuses.some((s) => s.stale)) {
    return { ...humanOnly(input, ['STALE_EVENTS'], { discardedEvents }, { segmentIds: statuses.filter((s) => s.stale).map((s) => s.segmentId) }), modification };
  }
  if (statuses.some((s) => s.unverifiable)) {
    return { ...humanOnly(input, ['NO_TRUSTED_SOURCE'], { discardedEvents }, { segmentIds: statuses.filter((s) => s.unverifiable).map((s) => s.segmentId) }), modification };
  }

  // 3) ¿Relevante?
  if (!modification.relevant) {
    return {
      bookingId, outcome: 'NO_ACTION', reasons: [], modification, entitlements: [], options: [],
      communication: { level: 'NONE' }, plannedActions: [],
      audit: { ...emptyAudit(now), discardedEvents, conflictReasons },
    };
  }

  // 4) Política (versionada, vigente y del escenario correcto)
  const scenario: Scenario = kinds.includes('CANCELLATION') ? 'CANCELLATION' : 'DELAY';
  const auditBase = { ...emptyAudit(now), discardedEvents, conflictReasons };
  const toHuman = (reasons: ReasonCode[], extra: Partial<Assessment['audit']> = {}) => ({
    ...humanOnly(input, reasons, { ...auditBase, ...extra }, { kinds }), modification,
  });
  if (!input.policy.ok) return toHuman(['POLICY_UNAVAILABLE']);
  const policy = input.policy.data;
  const policyValid =
    policy.scenario === scenario && policy.rules.length > 0 &&
    !policy.supersededVersions.includes(policy.version) &&
    policy.effectiveFrom <= now.toISOString().slice(0, 10);
  if (!policyValid) return toHuman(['POLICY_INVALID'], { policyVersion: policy.version });

  // 5) Hechos -> reglas
  const delayMinutes = Math.max(0, ...statuses.map((s) => (s.state === 'DELAYED' ? s.delayMinutes : 0)));
  const hasMinor = trip.passengers.some((p) => p.type !== 'ADULT' || (p.age !== undefined && p.age < 18));
  const facts: Facts = {
    delay_minutes: delayMinutes,
    missed_connection: connections.some((c) => c.status !== 'OK'),
    compensation_requested: input.request?.compensationRequested === true,
    group_includes_minor: hasMinor,
    international: isInternational(trip, input.reference.airportCountry),
  };
  const evaluation = evaluatePolicy(policy, facts);
  const withPolicy = { ...auditBase, policyVersion: policy.version, ruleResults: evaluation.ruleResults };
  if (evaluation.unresolved.length) {
    return toHuman(['POLICY_UNEVALUABLE'], withPolicy);
  }

  // 6) Opciones y decisión
  const reasons: ReasonCode[] = [];
  if (evaluation.entitlements.some((e) => e.requiresHumanApproval)) reasons.push('HUMAN_APPROVAL_REQUIRED');

  const hasRebook = evaluation.entitlements.some((e) => e.entitlement === 'REBOOK_NO_FEE');
  let options: EvaluatedOption[] = [];
  if (hasRebook) {
    if (!input.options.ok) reasons.push('OPTIONS_UNAVAILABLE');
    else {
      options = evaluateOptions(input.options.data, {
        trip, entitlements: evaluation.entitlements, policyVersion: policy.version, now, cfg,
        brokenConnection: connections.find((c) => c.status === 'MISSED_PREDICTED'),
      });
      if (!options.some((o) => o.status === 'OFFERABLE')) reasons.push('NO_OFFERABLE_OPTION');
    }
  }

  const disrupted = segments.filter((s) => s.state === 'DELAYED' || s.state === 'CANCELLED');
  const factParams = {
    affected: disrupted.map((s) => ({ flightNumber: s.flightNumber, state: s.state, delayMinutes: s.delayMinutes, newDeparture: s.newDeparture, gate: s.gate })),
    connectionAtRisk: connections.some((c) => c.status !== 'OK'), // redactar como "podría", es predicción
  };
  const offerable = options.filter((o) => o.status === 'OFFERABLE');

  if (reasons.length) {
    const evidence = {
      bookingId, reasons, kinds, policyVersion: policy.version,
      ruleIds: evaluation.entitlements.map((e) => e.ruleId),
      segmentIds: disrupted.map((s) => s.segmentId),
      eventIds: statuses.flatMap((s) => s.basedOnEventIds),
      suggestedOptionIds: offerable.map((o) => o.optionId),
      passengers: { total: trip.passengers.length, minors: trip.passengers.filter((p) => p.type !== 'ADULT' || (p.age !== undefined && p.age < 18)).length },
    };
    const reason = reasons.join('+');
    return {
      bookingId, outcome: 'HUMAN_REVIEW', reasons, modification,
      entitlements: evaluation.entitlements, options,
      communication: { level: 'FACTS_ONLY', templateId: 'DISRUPTION_FACTS_HANDOFF', policyRef: policy.version, params: factParams },
      plannedActions: [
        { tool: 'create_human_case', payload: { reason, evidence } },
        { tool: 'notify_passenger', after: 'create_human_case', payload: { templateId: 'DISRUPTION_FACTS_HANDOFF', policyRef: policy.version, params: factParams } },
      ],
      humanCase: { reason, priority: hasMinor ? 'HIGH' : 'NORMAL', evidence },
      audit: withPolicy,
    };
  }

  if (hasRebook) {
    const params = { ...factParams, options: offerable.map((o) => ({ optionId: o.optionId, flightNumber: o.option.flightNumber, date: o.option.date, departure: o.option.departure })) };
    return {
      bookingId, outcome: 'INFORM_AND_RECOMMEND', reasons, modification,
      entitlements: evaluation.entitlements, options,
      communication: { level: 'FULL', templateId: 'DISRUPTION_WITH_OPTIONS', policyRef: policy.version, params },
      plannedActions: [{ tool: 'notify_passenger', payload: { templateId: 'DISRUPTION_WITH_OPTIONS', policyRef: policy.version, params } }],
      audit: withPolicy,
    };
  }

  // Relevante pero sin derecho automático: solo informar hechos.
  return {
    bookingId, outcome: 'INFORM_ONLY', reasons, modification,
    entitlements: evaluation.entitlements, options,
    communication: { level: 'FACTS_ONLY', templateId: 'DISRUPTION_INFO', policyRef: policy.version, params: factParams },
    plannedActions: [{ tool: 'notify_passenger', payload: { templateId: 'DISRUPTION_INFO', policyRef: policy.version, params: factParams } }],
    audit: withPolicy,
  };
}

function isInternational(trip: Trip, airportCountry: ReferenceData['airportCountry']): boolean | undefined {
  let unknown = false;
  for (const s of trip.segments) {
    const o = airportCountry[s.origin];
    const d = airportCountry[s.destination];
    if (!o || !d) unknown = true;
    else if (o !== d) return true;
  }
  return unknown ? undefined : false;
}
