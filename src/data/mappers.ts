// Traducción contrato de tools <-> modelo de dominio. Único lugar donde conviven ambos.
// Regla de PII: lo que no se mapea no existe para el dominio (nombre, email, teléfono, documento, loyalty).
import { EventFeed, Option, OptionSet, Policy, Trip } from '../domain/model';
import * as c from './contracts';

const camel = (s: string) => s.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
/** "fare_conditions.change_penalty_amount" -> "fareConditions.changePenaltyAmount" */
const toDomainPath = (path: string) => path.split('.').map(camel).join('.');

/** Tolerante a listas ausentes: una reserva vacía la marca el dominio como TRIP_INCOMPLETE, no es un fallo de lectura. */
export function toTrip(t: c.TripContext): Trip {
  return {
    bookingId: t.booking_id,
    passengers: (t.passengers ?? []).map((p) => ({ id: p.passenger_id, type: p.type, age: p.age })),
    segments: (t.segments ?? []).map((s) => ({
      id: s.segment_id,
      flightNumber: s.flight_number,
      origin: s.origin,
      destination: s.destination,
      date: s.date,
      scheduledDeparture: s.scheduled_departure,
      scheduledArrival: s.scheduled_arrival,
    })),
    fareConditions: {
      changeable: t.fare_conditions.changeable,
      refundable: t.fare_conditions.refundable,
      fareFamily: t.fare_conditions.fare_family,
      changePenaltyAmount: t.fare_conditions.change_penalty_amount,
    },
    missingFields: (t._meta?.missing_fields ?? []).map(toDomainPath),
    retrievedAt: t._meta?.retrieved_at,
  };
}

/**
 * Inverso de toTrip para get_eligible_options. Supuesto a validar con el dueño de la tool: no necesita
 * nombre ni datos de contacto de los pasajeros, así que no se envían (el dominio tampoco los tiene).
 */
export function fromTrip(t: Trip): c.TripContext {
  return {
    booking_id: t.bookingId,
    passengers: t.passengers.map((p) => ({ passenger_id: p.id, type: p.type, age: p.age })),
    segments: t.segments.map((s) => ({
      segment_id: s.id,
      flight_number: s.flightNumber,
      origin: s.origin,
      destination: s.destination,
      date: s.date,
      scheduled_departure: s.scheduledDeparture,
      scheduled_arrival: s.scheduledArrival,
    })),
    fare_conditions: {
      changeable: t.fareConditions.changeable,
      refundable: t.fareConditions.refundable,
      fare_family: t.fareConditions.fareFamily,
      change_penalty_amount: t.fareConditions.changePenaltyAmount,
    },
    _meta: { retrieved_at: t.retrievedAt, completeness: t.missingFields.length ? 'PARTIAL' : 'FULL', missing_fields: [] },
  };
}

export function toEventFeed(f: c.OperationalEvents): EventFeed {
  return {
    events: f.events.map((e) => ({
      id: e.event_id,
      segmentId: e.segment_id,
      type: e.type,
      newDeparture: e.new_departure,
      delayMinutes: e.delay_minutes,
      gate: e.gate,
      status: e.status,
      source: e.source,
      recordedAt: e.recorded_at,
    })),
    retrievedAt: f._meta.retrieved_at,
    sourcesAvailable: f._meta.sources_available,
    sourcesDegraded: f._meta.sources_degraded,
  };
}

export function toOption(o: c.Option): Option {
  return {
    id: o.option_id,
    type: o.type,
    flightNumber: o.flight_number,
    origin: o.origin,
    destination: o.destination,
    date: o.date,
    departure: o.departure,
    fareDifference: o.fare_difference,
    currency: o.currency,
    seatsAvailable: o.seats_available,
    policyRef: o.policy_ref,
    confidence: o.confidence,
  };
}

/** Inverso de toOption: create_rebooking_request recibe la opción en el formato de la tool. */
export function fromOption(o: Option): c.Option {
  return {
    option_id: o.id,
    type: o.type,
    flight_number: o.flightNumber,
    origin: o.origin,
    destination: o.destination,
    date: o.date,
    departure: o.departure,
    fare_difference: o.fareDifference,
    currency: o.currency,
    seats_available: o.seatsAvailable,
    policy_ref: o.policyRef,
    confidence: o.confidence,
  };
}

export function toOptionSet(o: c.EligibleOptions): OptionSet {
  return { options: o.options.map(toOption), retrievedAt: o._meta.retrieved_at, ttlSeconds: o._meta.ttl_seconds };
}

export function toPolicy(p: c.PolicyRules): Policy {
  return {
    scenario: p.scenario,
    version: p.version,
    effectiveFrom: p.effective_from,
    rules: p.rules.map((r) => ({
      id: r.rule_id,
      condition: r.condition,
      entitlement: r.entitlement,
      requiresHumanApproval: r.requires_human_approval,
    })),
    supersededVersions: p._meta.superseded_versions,
    retrievedAt: p._meta.retrieved_at,
  };
}
