import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { toEventFeed, toOptionSet, toPolicy, toTrip } from '../src/data/mappers';
import { NOW, fx } from '../src/data/mock/fixtures';
import { REFERENCE_DATA } from '../src/data/reference/airports';
import { assessDisruption, AssessmentInput } from '../src/domain/assess-disruption';
import { evaluateCondition } from '../src/domain/policy-engine';
import { buildIdempotencyKey } from '../src/domain/idempotency';
import { fail, ok } from '../src/domain/model';

// Los fixtures están en el formato de las tools (enunciado); se mutan así y se pasan por el mapper de la capa de datos.
function input(mut?: (f: ReturnType<typeof fx>) => void, now = NOW, extra: Partial<Pick<AssessmentInput, 'request' | 'config'>> = {}): AssessmentInput {
  const f = fx();
  mut?.(f);
  return {
    bookingId: 'ABC123', now, reference: REFERENCE_DATA,
    trip: ok(toTrip(f.trip)), events: ok(toEventFeed(f.events)), policy: ok(toPolicy(f.policy)), options: ok(toOptionSet(f.options)),
    ...extra,
  };
}
const noMinor = (f: ReturnType<typeof fx>) => { f.trip.passengers = [f.trip.passengers[0]]; };

describe('caso base (enunciado)', () => {
  const a = assessDisruption(input());

  it('retraso de 160 min es relevante y la conexión se pierde (predicción)', () => {
    assert.deepEqual(a.modification.kinds, ['SIGNIFICANT_DELAY', 'CONNECTION_AT_RISK']);
    assert.equal(a.modification.connections[0].status, 'MISSED_PREDICTED');
    assert.equal(a.modification.connections[0].slackMinutes, -90);
    assert.equal(a.modification.segments[0].delayMinutes, 160);
  });

  it('R1 NO aplica (160 < 180); el derecho a reprogramar viene de R3 (conexión perdida)', () => {
    assert.equal(a.audit.ruleResults?.R1, false);
    assert.equal(a.audit.ruleResults?.R2, false);
    assert.deepEqual(a.entitlements.map((e) => e.ruleId), ['R3', 'R5']);
  });

  it('LEGACY_MIRROR (degradada, ON_TIME) se descarta y no contradice el retraso', () => {
    assert.deepEqual(a.audit.discardedEvents, [{ eventId: 'E-1012', reason: 'SOURCE_DEGRADED' }]);
    assert.equal(a.modification.segments[0].state, 'DELAYED');
    assert.equal(a.modification.segments[0].gate, '24');
  });

  it('grupo con menor (R5) => revisión humana, no recomendación automática', () => {
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.deepEqual(a.reasons, ['HUMAN_APPROVAL_REQUIRED']);
    assert.equal(a.humanCase?.priority, 'HIGH');
  });

  it('al pasajero solo se le comunican hechos validados (sin opciones ni promesas) con policy_ref', () => {
    assert.equal(a.communication.level, 'FACTS_ONLY');
    assert.equal(a.communication.policyRef, 'POL-DELAY-2026-03');
    assert.equal('options' in (a.communication.params ?? {}), false);
  });

  it('opciones: O1 ofrecible; O2 rechazada (1 asiento para 2 pax + cobro); O3 rechazada (tarifa no reembolsable)', () => {
    const by = Object.fromEntries(a.options.map((o) => [o.optionId, o]));
    assert.equal(by.O1.status, 'OFFERABLE');
    assert.equal(by.O2.status, 'REJECTED');
    assert.ok(by.O2.reasons.includes('INSUFFICIENT_SEATS') && by.O2.reasons.includes('REQUIRES_PAYMENT'));
    assert.equal(by.O3.status, 'REJECTED');
    assert.ok(by.O3.reasons.includes('FARE_NOT_REFUNDABLE'));
  });

  it('el caso humano se crea ANTES de notificar y la reprogramación nunca se ejecuta sola', () => {
    assert.deepEqual(a.plannedActions.map((p) => p.tool), ['create_human_case', 'notify_passenger']);
    assert.equal(a.plannedActions[1].after, 'create_human_case');
    assert.ok(!a.plannedActions.some((p) => (p.tool as string) === 'create_rebooking_request'));
  });

  it('la salida no contiene PII (email, teléfono, documento, nombres)', () => {
    const s = JSON.stringify(a);
    for (const pii of ['maria.silva', '8765 4321', '12.345.678-9', 'María', 'Tomás']) assert.ok(!s.includes(pii), pii);
  });
});

describe('automatización permitida', () => {
  it('sin menores y con O1 vigente => INFORM_AND_RECOMMEND (FULL) con solo O1', () => {
    const a = assessDisruption(input(noMinor));
    assert.equal(a.outcome, 'INFORM_AND_RECOMMEND');
    assert.equal(a.communication.level, 'FULL');
    assert.deepEqual((a.communication.params as any).options.map((o: any) => o.optionId), ['O1']);
  });

  it('TTL de opciones (120 s desde 11:02:35): a las 11:04 vigentes; a las 11:06 (feed aún fresco) vencidas => humano', () => {
    assert.equal(assessDisruption(input(noMinor, new Date('2026-09-15T11:04:00Z'))).outcome, 'INFORM_AND_RECOMMEND');
    const a = assessDisruption(input(noMinor, new Date('2026-09-15T11:06:00Z')));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.deepEqual(a.reasons, ['NO_OFFERABLE_OPTION']);
    assert.ok(a.options.every((o) => o.reasons.includes('OPTIONS_EXPIRED')));
  });

  it('TTL incalculable (retrieved_at inválido o ttl ausente) => opciones vencidas, no vigentes para siempre', () => {
    for (const mut of [
      (f: ReturnType<typeof fx>) => { f.options._meta.retrieved_at = 'no-es-fecha'; },
      (f: ReturnType<typeof fx>) => { delete (f.options._meta as Partial<typeof f.options._meta>).ttl_seconds; },
    ]) {
      const a = assessDisruption(input((f) => { noMinor(f); mut(f); }));
      assert.deepEqual(a.reasons, ['NO_OFFERABLE_OPTION']);
      assert.ok(a.options.every((o) => o.reasons.includes('OPTIONS_EXPIRED')));
    }
  });

  it('retraso de 15 min con holgura de 55 min (>= MCT 45) => NO_ACTION y silencio', () => {
    const a = assessDisruption(input((f) => {
      noMinor(f);
      f.events.events[0].delay_minutes = 15; f.events.events[0].new_departure = '14:45';
    }));
    assert.equal(a.outcome, 'NO_ACTION');
    assert.equal(a.communication.level, 'NONE');
  });

  it('retraso de 30 min < umbral de relevancia, pero holgura 40 < MCT 45 => conexión en riesgo igual cuenta', () => {
    const a = assessDisruption(input((f) => {
      noMinor(f);
      f.events.events[0].delay_minutes = 30; f.events.events[0].new_departure = '15:00';
    }));
    assert.deepEqual(a.modification.kinds, ['CONNECTION_AT_RISK']);
  });
});

describe('fuentes contradictorias, datos viejos y fallos (fail-closed)', () => {
  it('dos fuentes confiables discrepan => SOURCE_CONFLICT, sin comunicar nada', () => {
    const a = assessDisruption(input((f) => {
      f.events.events.push({ event_id: 'E-9', segment_id: 'S1', type: 'STATUS', status: 'ON_TIME', source: 'AIRPORT_FEED', recorded_at: '2026-09-15T10:58:00Z' });
    }));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.deepEqual(a.reasons, ['SOURCE_CONFLICT']);
    assert.equal(a.communication.level, 'NONE');
  });

  it('evento de retraso incoherente (delay_minutes != new_departure) => conflicto, no se adivina', () => {
    const a = assessDisruption(input((f) => { f.events.events[0].delay_minutes = 90; }));
    assert.deepEqual(a.reasons, ['SOURCE_CONFLICT']);
  });

  it('feed operacional viejo => no se comunica', () => {
    const a = assessDisruption(input((f) => { f.events._meta.retrieved_at = '2026-09-15T10:40:00Z'; }));
    assert.deepEqual(a.reasons, ['EVENTS_FEED_STALE']);
    assert.equal(a.communication.level, 'NONE');
  });

  it('retraso registrado hace más de 120 min => STALE_EVENTS', () => {
    const a = assessDisruption(input((f) => { f.events.events[0].recorded_at = '2026-09-15T08:00:00Z'; }));
    assert.deepEqual(a.reasons, ['STALE_EVENTS']);
  });

  it('solo hay fuente degradada => estado UNKNOWN (no se afirma ON_TIME) y revisión humana sin comunicar', () => {
    const a = assessDisruption(input((f) => { f.events.events = f.events.events.filter((e) => e.source === 'LEGACY_MIRROR'); }));
    assert.equal(a.modification.segments[0].state, 'UNKNOWN');
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.deepEqual(a.reasons, ['NO_TRUSTED_SOURCE']);
    assert.equal(a.communication.level, 'NONE');
    assert.deepEqual(a.humanCase?.evidence.segmentIds, ['S1']);
  });

  it('segmento sin ningún evento de estado => sin indicio de modificación, NO_ACTION (no se deriva todo a humano)', () => {
    const a = assessDisruption(input((f) => { f.events.events = f.events.events.filter((e) => e.segment_id === 'S2'); }));
    assert.equal(a.modification.segments[0].state, 'UNKNOWN');
    assert.equal(a.outcome, 'NO_ACTION');
  });

  it('solo un cambio de puerta (de fuente confiable) => informativo, no dispara flujo', () => {
    const a = assessDisruption(input((f) => { f.events.events = f.events.events.filter((e) => !['E-1001', 'E-1012'].includes(e.event_id)); }));
    assert.equal(a.modification.segments[0].gate, '24');
    assert.equal(a.outcome, 'NO_ACTION');
  });

  it('falla get_trip_context / get_operational_events / política => humano sin comunicar', () => {
    assert.deepEqual(assessDisruption({ ...input(), trip: fail('x') }).reasons, ['TRIP_UNAVAILABLE']);
    assert.deepEqual(assessDisruption({ ...input(), events: fail('x') }).reasons, ['EVENTS_UNAVAILABLE']);
    const p = assessDisruption({ ...input(), policy: fail('x') });
    assert.deepEqual(p.reasons, ['POLICY_UNAVAILABLE']);
    assert.equal(p.communication.level, 'NONE');
  });

  it('opciones no disponibles => hechos + humano', () => {
    const a = assessDisruption({ ...input(noMinor), options: fail('x') });
    assert.deepEqual(a.reasons, ['OPTIONS_UNAVAILABLE']);
    assert.equal(a.communication.level, 'FACTS_ONLY');
  });

  it('reserva con campo faltante bloqueante => TRIP_INCOMPLETE; el campo no bloqueante del ejemplo no bloquea', () => {
    const a = assessDisruption(input((f) => { f.trip._meta.missing_fields.push('segments[1].scheduled_departure'); }));
    assert.deepEqual(a.reasons, ['TRIP_INCOMPLETE']);
    assert.equal(assessDisruption(input(noMinor)).outcome, 'INFORM_AND_RECOMMEND');
  });

  it('política supersedida o de otro escenario => POLICY_INVALID', () => {
    const a = assessDisruption(input((f) => { f.policy._meta.superseded_versions.push(f.policy.version); }));
    assert.deepEqual(a.reasons, ['POLICY_INVALID']);
  });

  it('datos malformados no lanzan excepción: INTERNAL_INCONSISTENCY', () => {
    const a = assessDisruption(input((f) => { f.trip.segments[0].scheduled_arrival = '25:99'; }));
    assert.deepEqual(a.reasons, ['INTERNAL_INCONSISTENCY']);
  });

  it('compensación solicitada (R4) exige aprobación humana', () => {
    const a = assessDisruption(input(noMinor, NOW, { request: { compensationRequested: true } }));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.ok(a.entitlements.some((e) => e.ruleId === 'R4'));
  });
});

// Retraso de S1 coherente: new_departure = 14:30 + minutos (si no, el reconciliador lo trata como conflicto).
const delayS1 = (minutes: number, unknownAirports = false) => (f: ReturnType<typeof fx>) => {
  const dep = 14 * 60 + 30 + minutes;
  f.events.events[0].delay_minutes = minutes;
  f.events.events[0].new_departure = `${String(Math.floor(dep / 60)).padStart(2, '0')}:${String(dep % 60).padStart(2, '0')}`;
  // Basta un tramo entre países distintos para que el viaje sea internacional: para que quede
  // indeterminado, ningún tramo puede tener ambos países conocidos.
  if (unknownAirports) { f.trip.segments[0].origin = 'ZZZ'; f.trip.segments[1].destination = 'YYY'; }
};

describe('política: bordes de R1 y R2 (enunciado)', () => {
  it('R1 en el borde: 179 min no aplica; 180 min aplica (delay_minutes >= 180)', () => {
    assert.equal(assessDisruption(input(delayS1(179))).audit.ruleResults?.R1, false);
    const a = assessDisruption(input(delayS1(180)));
    assert.equal(a.audit.ruleResults?.R1, true);
    assert.ok(a.entitlements.some((e) => e.ruleId === 'R1' && e.entitlement === 'REBOOK_NO_FEE'));
  });

  it('R2 aplica con 240 min en vuelo internacional (SCL->LIM): MEAL_VOUCHER; con 239 no', () => {
    assert.equal(assessDisruption(input(delayS1(239))).audit.ruleResults?.R2, false);
    const a = assessDisruption(input(delayS1(240)));
    assert.equal(a.audit.ruleResults?.R2, true);
    assert.ok(a.entitlements.some((e) => e.ruleId === 'R2' && e.entitlement === 'MEAL_VOUCHER'));
  });

  it('R2 sin poder determinar si es internacional: no se asume nacional => POLICY_UNEVALUABLE (humano)', () => {
    const a = assessDisruption(input(delayS1(240, true)));
    assert.equal(a.audit.ruleResults?.R2, null);
    assert.deepEqual(a.reasons, ['POLICY_UNEVALUABLE']);
    assert.equal(a.communication.level, 'NONE');
  });

  it('con retraso < 240 el aeropuerto desconocido no importa (false AND desconocido = false)', () => {
    const a = assessDisruption(input(delayS1(160, true)));
    assert.equal(a.audit.ruleResults?.R2, false);
    assert.notDeepEqual(a.reasons, ['POLICY_UNEVALUABLE']);
  });
});

// Sin el evento degradado de LEGACY_MIRROR: así se prueba la fuente confiable sola, sin que el
// descarte de la degradada (NO_TRUSTED_SOURCE) enmascare el resultado.
const trustedOnly = (mut: (f: ReturnType<typeof fx>) => void) => (f: ReturnType<typeof fx>) => {
  noMinor(f);
  f.events.events = f.events.events.filter((e) => e.event_id !== 'E-1012');
  mut(f);
};

describe('eventos malformados o desconocidos de fuente confiable (fail-closed)', () => {
  it('recorded_at inválido en un DELAY de OPS_CORE => conflicto y humano, no NO_ACTION', () => {
    const a = assessDisruption(input(trustedOnly((f) => { f.events.events[0].recorded_at = 'no-es-fecha'; })));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.deepEqual(a.reasons, ['SOURCE_CONFLICT']);
    assert.ok(a.audit.conflictReasons.includes('TIMESTAMP_INVALID:E-1001'));
  });

  it('STATUS desconocido (DIVERTED) de OPS_CORE => humano, no se asume "sin novedad"', () => {
    const a = assessDisruption(input(trustedOnly((f) => {
      f.events.events[0] = { event_id: 'E-X', segment_id: 'S1', type: 'STATUS', status: 'DIVERTED', source: 'OPS_CORE', recorded_at: '2026-09-15T10:58:00Z' };
    })));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.ok(a.audit.conflictReasons.includes('STATUS_UNSUPPORTED:E-X:DIVERTED'));
  });

  it('tipo de evento desconocido de OPS_CORE => humano', () => {
    const a = assessDisruption(input(trustedOnly((f) => {
      f.events.events[0] = { event_id: 'E-Y', segment_id: 'S1', type: 'DIVERSION' as never, source: 'OPS_CORE', recorded_at: '2026-09-15T10:58:00Z' };
    })));
    assert.equal(a.outcome, 'HUMAN_REVIEW');
    assert.ok(a.audit.conflictReasons.includes('EVENT_TYPE_UNSUPPORTED:E-Y'));
  });
});

describe('evaluador de condiciones (sin eval)', () => {
  it('lógica de 3 valores: false AND desconocido => false; true AND desconocido => desconocido', () => {
    assert.equal(evaluateCondition('delay_minutes >= 240 AND international', { delay_minutes: 160 }), false);
    assert.equal(evaluateCondition('delay_minutes >= 240 AND international', { delay_minutes: 300 }), null);
    assert.equal(evaluateCondition('delay_minutes >= 240 AND international', { delay_minutes: 300, international: true }), true);
  });

  it('gramática no soportada => UNPARSEABLE y la política queda inevaluable (no se ejecuta código)', () => {
    assert.equal(evaluateCondition('process.exit(1)', {}), 'UNPARSEABLE');
    assert.equal(evaluateCondition('delay_minutes >= 10 OR foo', { delay_minutes: 1 }), 'UNPARSEABLE');
    const a = assessDisruption(input((f) => { f.policy.rules[2].condition = 'missed_connection ~= maybe'; }));
    assert.deepEqual(a.reasons, ['POLICY_UNEVALUABLE']);
  });
});

describe('idempotencia', () => {
  const p = { bookingId: 'ABC123', optionId: 'O1', policyVersion: 'POL-DELAY-2026-03', passengerIds: ['P1', 'P2'] };
  it('misma entrada => misma clave (independiente del orden); distinta opción => otra clave', () => {
    assert.equal(buildIdempotencyKey(p), buildIdempotencyKey({ ...p, passengerIds: ['P2', 'P1'] }));
    assert.notEqual(buildIdempotencyKey(p), buildIdempotencyKey({ ...p, optionId: 'O2' }));
  });
});
