// Puertos que la aplicación necesita, en lenguaje de dominio. Los implementa la capa de datos (src/data).
// Lecturas y escrituras separadas: quien solo evalúa no recibe capacidad de escribir (mínimo privilegio).
import { EventFeed, Option, OptionSet, Policy, Result, Trip } from '../domain/model';

/** Lecturas. Nunca lanzan: un fallo o timeout llega como Result fallido y el dominio lo deriva a humano. */
export interface DisruptionDataPort {
  getTrip(bookingId: string): Promise<Result<Trip>>;
  getEvents(segmentIds: string[]): Promise<Result<EventFeed>>;
  getOptions(trip: Trip): Promise<Result<OptionSet>>;
  getPolicy(scenario: string): Promise<Result<Policy>>;
}

export type RebookingAttempt =
  | { kind: 'CREATED'; requestId: string; expiresAt?: string }
  | { kind: 'DUPLICATE'; requestId: string } // 409: misma clave ya procesada
  | { kind: 'INDETERMINATE' }; // 503, timeout o error de red: el resultado real se desconoce

export interface PassengerNotification {
  bookingId: string;
  templateId: string;
  policyRef: string;
  params: Record<string, unknown>;
}

export interface HumanCase {
  caseId: string;
  queue: string;
  slaMinutes: number;
}

/** Escrituras. Nunca lanzan. */
export interface DisruptionActionsPort {
  requestRebooking(option: Option, idempotencyKey: string): Promise<RebookingAttempt>;
  openHumanCase(reason: string, evidence: Record<string, unknown>): Promise<Result<HumanCase>>;
  notifyPassenger(message: PassengerNotification): Promise<Result<{ notificationId: string }>>;
}
