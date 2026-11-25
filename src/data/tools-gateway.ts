// Implementa los puertos de la aplicación sobre las tools externas:
//  - timeout por llamada y conversión de cualquier fallo a Result (nunca lanza);
//  - traducción contrato <-> dominio (mappers), que además descarta la PII.
import {
  DisruptionActionsPort, DisruptionDataPort, HumanCase, PassengerNotification, RebookingAttempt,
} from '../application/ports';
import { EventFeed, Option, OptionSet, Policy, Result, Trip, fail, ok } from '../domain/model';
import { fromOption, fromTrip, toEventFeed, toOptionSet, toPolicy, toTrip } from './mappers';
import { ToolsPort } from './tools.port';

export class ToolsGateway implements DisruptionDataPort, DisruptionActionsPort {
  constructor(private readonly tools: ToolsPort, private readonly timeoutMs = 3000) {}

  /** Ejecuta una tool con timeout y la convierte en Result. */
  private async call<T>(label: string, fn: () => Promise<T>): Promise<Result<T>> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), this.timeoutMs); });
      return ok(await Promise.race([fn(), timeout]));
    } catch (e) {
      return fail(`${label}:${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ---------- lecturas ----------

  async getTrip(bookingId: string): Promise<Result<Trip>> {
    return this.call('trip', async () => toTrip(await this.tools.getTripContext(bookingId)));
  }

  async getEvents(segmentIds: string[]): Promise<Result<EventFeed>> {
    return this.call('events', async () => toEventFeed(await this.tools.getOperationalEvents(segmentIds)));
  }

  async getOptions(trip: Trip): Promise<Result<OptionSet>> {
    // Se reconstruye el trip_context SIN PII (mínimo privilegio): calcular opciones no requiere contacto ni documento.
    return this.call('options', async () => toOptionSet(await this.tools.getEligibleOptions(fromTrip(trip))));
  }

  async getPolicy(scenario: string): Promise<Result<Policy>> {
    return this.call('policy', async () => toPolicy(await this.tools.getPolicyRules(scenario)));
  }

  // ---------- escrituras ----------

  async requestRebooking(option: Option, idempotencyKey: string): Promise<RebookingAttempt> {
    const r = await this.call('rebooking', () => this.tools.createRebookingRequest(fromOption(option), idempotencyKey));
    if (!r.ok) return { kind: 'INDETERMINATE' }; // timeout / red: no se sabe si se procesó
    if (r.data.status === 201) return { kind: 'CREATED', requestId: r.data.request_id, expiresAt: r.data.expires_at };
    if (r.data.status === 409) return { kind: 'DUPLICATE', requestId: r.data.request_id };
    return { kind: 'INDETERMINATE' };
  }

  async openHumanCase(reason: string, evidence: Record<string, unknown>): Promise<Result<HumanCase>> {
    const r = await this.call('human_case', () => this.tools.createHumanCase(reason, evidence));
    return r.ok ? ok({ caseId: r.data.case_id, queue: r.data.queue, slaMinutes: r.data.sla_minutes }) : r;
  }

  async notifyPassenger(m: PassengerNotification): Promise<Result<{ notificationId: string }>> {
    const r = await this.call('notify', () =>
      this.tools.notifyPassenger({ booking_id: m.bookingId, template_id: m.templateId, policy_ref: m.policyRef, params: m.params }));
    if (!r.ok) return r;
    return r.data.status === 202 ? ok({ notificationId: r.data.notification_id }) : fail(r.data.error);
  }
}
