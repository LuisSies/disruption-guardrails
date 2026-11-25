import { Assessment, assessDisruption, detectScenario } from '../domain/assess-disruption';
import { Config } from '../domain/config';
import { ReferenceData, fail } from '../domain/model';
import { DisruptionActionsPort, DisruptionDataPort } from './ports';

export interface ActResult {
  humanCase?: { caseId: string; queue: string; slaMinutes: number } | { error: string };
  notification?: { notificationId: string } | { error: string } | { skipped: string };
}

export interface AssessmentServiceDeps {
  data: DisruptionDataPort;
  actions: DisruptionActionsPort;
  reference: ReferenceData;
  clock?: () => Date;
  config?: Partial<Config>;
  log?: (msg: string) => void;
}

/**
 * Orquesta la capa de datos y delega TODA la decisión en la función pura assessDisruption.
 * Las lecturas llegan como Result (timeouts y fallos ya resueltos en la capa de datos): un fallo
 * no tumba la respuesta, degrada hacia humano.
 * Costo: lecturas mínimas (reserva -> eventos -> [política || opciones] solo si hay modificación relevante).
 */
export class AssessmentService {
  private readonly clock: () => Date;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: AssessmentServiceDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.log = deps.log ?? (() => undefined);
  }

  async assess(bookingId: string, request: { compensationRequested?: boolean } = {}): Promise<Assessment> {
    const { data, config = {}, reference } = this.deps;
    const now = this.clock();
    const trip = await data.getTrip(bookingId);
    const events = trip.ok ? await data.getEvents(trip.data.segments.map((s) => s.id)) : fail<never>('SKIPPED');

    const scenario = trip.ok && events.ok ? detectScenario(trip.data, events.data, now, config) : null;
    const [policy, options] =
      trip.ok && scenario
        ? await Promise.all([data.getPolicy(scenario), data.getOptions(trip.data)])
        : [fail<never>('NOT_REQUESTED'), fail<never>('NOT_REQUESTED')];

    const a = assessDisruption({ bookingId, now, trip, events, policy, options, request, config, reference });
    // Log sin PII: solo códigos de decisión.
    this.log(`assessment outcome=${a.outcome} reasons=${a.reasons.join(',') || '-'} policy=${a.audit.policyVersion ?? '-'}`);
    return a;
  }

  /** Ejecuta las acciones planificadas. Nunca ejecuta cambios de reserva: eso exige confirmación explícita. */
  async act(a: Assessment): Promise<ActResult> {
    const { actions } = this.deps;
    const out: ActResult = {};
    const caseAction = a.plannedActions.find((p) => p.tool === 'create_human_case');
    if (caseAction) {
      const c = await actions.openHumanCase(String(caseAction.payload.reason), caseAction.payload.evidence as Record<string, unknown>);
      out.humanCase = c.ok ? c.data : { error: c.error };
    }
    const notify = a.plannedActions.find((p) => p.tool === 'notify_passenger');
    if (notify) {
      if (notify.after === 'create_human_case' && !(out.humanCase && 'caseId' in out.humanCase)) {
        out.notification = { skipped: 'HUMAN_CASE_NOT_CREATED' }; // no prometer contacto humano sin caso
      } else {
        const { templateId, policyRef, params } = notify.payload as { templateId: string; policyRef: string; params: Record<string, unknown> };
        const r = await actions.notifyPassenger({ bookingId: a.bookingId, templateId, policyRef, params });
        out.notification = r.ok ? r.data : { error: r.error };
      }
    }
    return out;
  }
}
