import { Config } from './config';
import { ConnectionRisk } from './connections';
import { Entitlement } from './policy-engine';
import { localMinutes } from './time';
import { Option, OptionSet, Trip } from './model';

/**
 * get_eligible_options devuelve CANDIDATAS, no decisiones. Aquí se validan contra
 * política, asientos, vigencia y coherencia con la conexión afectada.
 *  - OFFERABLE : puede proponerse al pasajero.
 *  - AGENT_ONLY: solo un agente humano puede ofrecerla (cobro, confianza media, sin derecho).
 *  - REJECTED  : no se ofrece a nadie.
 */
export interface EvaluatedOption {
  optionId: string;
  type: Option['type'];
  status: 'OFFERABLE' | 'AGENT_ONLY' | 'REJECTED';
  reasons: string[];
  option: Option; // sin PII; necesario para ejecutar create_rebooking_request
}

export interface OptionsContext {
  trip: Trip;
  entitlements: Entitlement[];
  policyVersion: string;
  now: Date;
  brokenConnection?: ConnectionRisk;
  cfg: Config;
}

export function evaluateOptions(opts: OptionSet, ctx: OptionsContext): EvaluatedOption[] {
  // Fail-closed: si no se puede calcular el vencimiento (timestamp o TTL inválidos), se considera vencida.
  const expiresAt = Date.parse(opts.retrievedAt) + opts.ttlSeconds * 1000;
  const expired = !Number.isFinite(expiresAt) || expiresAt < ctx.now.getTime();
  const pax = ctx.trip.passengers.length;
  const hasNoFee = ctx.entitlements.some((e) => e.entitlement === 'REBOOK_NO_FEE');

  const evaluated = opts.options.map((o): EvaluatedOption => {
    const hard: string[] = [];
    const soft: string[] = [];

    if (expired) hard.push('OPTIONS_EXPIRED');
    if (o.policyRef !== ctx.policyVersion) hard.push('POLICY_MISMATCH');
    if (o.confidence === 'LOW') hard.push('LOW_CONFIDENCE');
    if (o.confidence === 'MEDIUM') soft.push('MEDIUM_CONFIDENCE');

    if (o.type === 'REBOOK') {
      if ((o.seatsAvailable ?? 0) < pax) hard.push('INSUFFICIENT_SEATS');
      if (typeof o.fareDifference !== 'number') hard.push('FARE_UNKNOWN');
      else if (o.fareDifference > 0) soft.push('REQUIRES_PAYMENT');
      if (!hasNoFee) soft.push('NO_ENTITLEMENT');

      const c = ctx.brokenConnection;
      if (c && o.date && o.departure) {
        if (o.origin !== c.airport || o.destination !== c.finalDestination) hard.push('ROUTE_MISMATCH');
        const earliest = c.estimatedArrivalLocal + ctx.cfg.minConnectionMinutes;
        if (localMinutes(o.date, o.departure) < earliest) hard.push('DEPARTS_BEFORE_ARRIVAL');
      }
    } else if (o.type === 'REFUND') {
      if (!ctx.trip.fareConditions.refundable) hard.push('FARE_NOT_REFUNDABLE');
      // Una devolución solo es automática si la política la otorga; si no, la decide un agente.
      if (!ctx.entitlements.some((e) => e.entitlement === 'REFUND')) soft.push('NO_ENTITLEMENT');
    } else {
      hard.push('UNSUPPORTED_TYPE');
    }

    const status = hard.length ? 'REJECTED' : soft.length ? 'AGENT_ONLY' : 'OFFERABLE';
    return { optionId: o.id, type: o.type, status, reasons: [...hard, ...soft], option: o };
  });

  const rank = { OFFERABLE: 0, AGENT_ONLY: 1, REJECTED: 2 } as const;
  const when = (e: EvaluatedOption) =>
    e.option.date && e.option.departure ? localMinutes(e.option.date, e.option.departure) : Infinity;
  return evaluated.sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      (a.option.fareDifference ?? Infinity) - (b.option.fareDifference ?? Infinity) ||
      when(a) - when(b),
  );
}
