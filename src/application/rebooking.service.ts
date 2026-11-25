import { buildIdempotencyKey } from '../domain/idempotency';
import { AssessmentService } from './assessment.service';
import { DisruptionActionsPort, DisruptionDataPort } from './ports';

export type RebookingOutcome =
  | { status: 'PENDING_CONFIRMATION'; requestId: string; expiresAt?: string }
  | { status: 'ALREADY_REQUESTED'; requestId: string }
  | { status: 'REJECTED'; reason: 'OPTION_NOT_OFFERABLE' | 'APPROVAL_REQUIRED' | 'TRIP_UNAVAILABLE' }
  | { status: 'INDETERMINATE'; humanCaseId?: string };

/**
 * Único camino que invoca create_rebooking_request. Requiere:
 *  - confirmación explícita del pasajero (la llamada a este método ES esa confirmación);
 *  - re-evaluación con datos frescos (las opciones expiran en ~120 s);
 *  - que la evaluación permita recomendar automáticamente (INFORM_AND_RECOMMEND).
 *
 * Si la política exige aprobación humana (R4/R5) o hay cualquier otro motivo de HUMAN_REVIEW, este
 * camino SIEMPRE rechaza: la reprogramación la ejecuta el agente desde su backoffice. No se acepta una
 * "aprobación" enviada por el cliente, porque el servidor no puede verificarla (no existe una tool para
 * consultar el estado de un caso) y el caseId que devuelve ?act=true quedaría como auto-aprobación.
 */
export class RebookingService {
  constructor(
    private readonly assessments: AssessmentService,
    private readonly data: DisruptionDataPort,
    private readonly actions: DisruptionActionsPort,
  ) {}

  async confirm(bookingId: string, optionId: string): Promise<RebookingOutcome> {
    const a = await this.assessments.assess(bookingId);
    const chosen = a.options.find((o) => o.optionId === optionId && o.status === 'OFFERABLE');
    if (!chosen) return { status: 'REJECTED', reason: 'OPTION_NOT_OFFERABLE' };
    // create_rebooking_request solo reprograma: una devolución nunca entra por este camino.
    if (chosen.type !== 'REBOOK') return { status: 'REJECTED', reason: 'OPTION_NOT_OFFERABLE' };

    if (a.outcome !== 'INFORM_AND_RECOMMEND') return { status: 'REJECTED', reason: 'APPROVAL_REQUIRED' };

    // Si la lectura falla aún no se escribió nada: se rechaza de forma controlada (reintentable), no un 500.
    const trip = await this.data.getTrip(bookingId);
    if (!trip.ok) return { status: 'REJECTED', reason: 'TRIP_UNAVAILABLE' };
    const key = buildIdempotencyKey({
      bookingId, optionId, policyVersion: a.audit.policyVersion ?? 'UNKNOWN',
      passengerIds: trip.data.passengers.map((p) => p.id),
    });

    // 503 / timeout => resultado INDETERMINADO. Se reintenta con la MISMA clave (nunca una nueva).
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.actions.requestRebooking(chosen.option, key);
      if (r.kind === 'CREATED') return { status: 'PENDING_CONFIRMATION', requestId: r.requestId, expiresAt: r.expiresAt };
      if (r.kind === 'DUPLICATE') return { status: 'ALREADY_REQUESTED', requestId: r.requestId }; // idempotencia = éxito
    }
    // Sigue indeterminado: no afirmar éxito ni fallo al pasajero; que una persona concilie.
    const c = await this.actions.openHumanCase('REBOOKING_INDETERMINATE', { bookingId, optionId, idempotencyKey: key });
    return c.ok ? { status: 'INDETERMINATE', humanCaseId: c.data.caseId } : { status: 'INDETERMINATE' };
  }
}
