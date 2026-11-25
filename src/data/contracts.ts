// Capa de datos: contratos de las tools tal como los define el enunciado (snake_case).
// Solo src/data los conoce; el dominio trabaja con src/domain/model.ts (ver mappers.ts).

export interface Passenger {
  passenger_id: string;
  name?: string; // presente al leer; no se envía de vuelta a get_eligible_options (ver mappers.fromTrip)
  type: 'ADULT' | 'CHILD' | 'INFANT';
  age?: number;
  // PII: existe en el contrato de entrada; el mapper la descarta y nunca llega al dominio.
  email?: string;
  phone?: string;
  document_id?: string;
  loyalty_tier?: string;
}

export interface Segment {
  segment_id: string;
  flight_number: string;
  origin: string;
  destination: string;
  date: string; // YYYY-MM-DD (hora local de cada aeropuerto)
  scheduled_departure: string; // HH:mm local
  scheduled_arrival: string; // HH:mm local (aeropuerto de destino)
}

export interface TripContext {
  booking_id: string;
  passengers: Passenger[];
  segments: Segment[];
  fare_conditions: {
    changeable: boolean;
    refundable: boolean;
    fare_family: string;
    change_penalty_amount?: number;
  };
  _meta: { retrieved_at: string; completeness: 'FULL' | 'PARTIAL'; missing_fields: string[] };
}

export interface OperationalEvent {
  event_id: string;
  segment_id: string;
  type: 'DELAY' | 'GATE_CHANGE' | 'STATUS' | 'CANCELLATION';
  new_departure?: string;
  delay_minutes?: number;
  gate?: string;
  status?: string;
  source: string;
  recorded_at: string; // ISO UTC
}

export interface OperationalEvents {
  events: OperationalEvent[];
  _meta: { retrieved_at: string; sources_available: string[]; sources_degraded: string[] };
}

export interface Option {
  option_id: string;
  type: 'REBOOK' | 'REFUND';
  flight_number?: string;
  origin?: string;
  destination?: string;
  date?: string;
  departure?: string;
  fare_difference?: number;
  currency?: string;
  seats_available?: number;
  policy_ref: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface EligibleOptions {
  options: Option[];
  _meta: { retrieved_at: string; ttl_seconds: number };
}

export interface PolicyRule {
  rule_id: string;
  condition: string;
  entitlement: string;
  requires_human_approval: boolean;
}

export interface PolicyRules {
  scenario: string;
  version: string;
  effective_from: string;
  rules: PolicyRule[];
  _meta: { retrieved_at: string; superseded_versions: string[] };
}
