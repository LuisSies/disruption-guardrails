import { EligibleOptions, OperationalEvents, Option, PolicyRules, TripContext } from './contracts';

// Interfaz de las tools EXTERNAS (contratos del enunciado). La implementa un cliente real o el mock.
// La aplicación no la usa directamente: pasa por ToolsGateway, que traduce al modelo de dominio.

export type RebookingResponse =
  | { status: 201; request_id: string; request_status: string; expires_at: string }
  | { status: 409; request_id: string }
  | { status: 503 };

export interface NotificationMessage {
  template_id: string;
  policy_ref: string; // sin policy_ref la tool responde 422 UNVALIDATED_CONTENT
  params: Record<string, unknown>;
  booking_id: string;
}

export type NotifyResponse = { status: 202; notification_id: string } | { status: 422; error: string };

/** Las 7 operaciones del enunciado. */
export interface ToolsPort {
  getTripContext(bookingId: string): Promise<TripContext>;
  getOperationalEvents(segmentIds: string[]): Promise<OperationalEvents>;
  getEligibleOptions(trip: TripContext): Promise<EligibleOptions>;
  getPolicyRules(scenario: string): Promise<PolicyRules>;
  createRebookingRequest(option: Option, idempotencyKey: string): Promise<RebookingResponse>;
  createHumanCase(reason: string, evidence: Record<string, unknown>): Promise<{ case_id: string; queue: string; sla_minutes: number }>;
  notifyPassenger(message: NotificationMessage): Promise<NotifyResponse>;
}
