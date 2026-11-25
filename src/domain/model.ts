// Modelo de dominio: lo que la lógica de negocio necesita, con nombres propios.
// No depende de los contratos de las tools (snake_case): la capa de datos (src/data) traduce.
// Sin PII: nombre, email, teléfono, documento y loyalty no existen aquí; se descartan en el mapper.

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
export const ok = <T>(data: T): Result<T> => ({ ok: true, data });
export const fail = <T = never>(error: string): Result<T> => ({ ok: false, error });

export interface Passenger {
  id: string;
  type: 'ADULT' | 'CHILD' | 'INFANT';
  age?: number;
}

export interface Segment {
  id: string;
  flightNumber: string;
  origin: string;
  destination: string;
  date: string; // YYYY-MM-DD (hora local de cada aeropuerto)
  scheduledDeparture: string; // HH:mm local
  scheduledArrival: string; // HH:mm local (aeropuerto de destino)
}

export interface Trip {
  bookingId: string;
  passengers: Passenger[];
  segments: Segment[];
  fareConditions: { changeable: boolean; refundable: boolean; fareFamily: string; changePenaltyAmount?: number };
  /** Campos que la fuente reportó como faltantes, como rutas del modelo de dominio (p.ej. "fareConditions.changePenaltyAmount"). */
  missingFields: string[];
  retrievedAt: string; // ISO UTC
}

export interface OperationalEvent {
  id: string;
  segmentId: string;
  type: 'DELAY' | 'GATE_CHANGE' | 'STATUS' | 'CANCELLATION';
  newDeparture?: string;
  delayMinutes?: number;
  gate?: string;
  status?: string;
  source: string;
  recordedAt: string; // ISO UTC
}

export interface EventFeed {
  events: OperationalEvent[];
  retrievedAt: string; // ISO UTC
  sourcesAvailable: string[];
  sourcesDegraded: string[];
}

export interface Option {
  id: string;
  type: 'REBOOK' | 'REFUND';
  flightNumber?: string;
  origin?: string;
  destination?: string;
  date?: string;
  departure?: string;
  fareDifference?: number;
  currency?: string;
  seatsAvailable?: number;
  policyRef: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface OptionSet {
  options: Option[];
  retrievedAt: string; // ISO UTC
  ttlSeconds: number;
}

export interface PolicyRule {
  id: string;
  condition: string;
  entitlement: string;
  requiresHumanApproval: boolean;
}

export interface Policy {
  scenario: string;
  version: string;
  effectiveFrom: string; // YYYY-MM-DD
  rules: PolicyRule[];
  supersededVersions: string[];
  retrievedAt: string; // ISO UTC
}

/** Datos de referencia que el dominio consulta pero no posee (vienen de la capa de datos). */
export interface ReferenceData {
  /** Aeropuerto IATA -> país. Aeropuerto desconocido => el hecho "international" queda indeterminado. */
  airportCountry: Readonly<Record<string, string>>;
}
