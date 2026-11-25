import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AssessmentService } from '../src/application/assessment.service';
import { RebookingService } from '../src/application/rebooking.service';
import { NOW, fx } from '../src/data/mock/fixtures';
import { mockTools } from '../src/data/mock/mock-tools';
import { REFERENCE_DATA } from '../src/data/reference/airports';
import { ToolsGateway } from '../src/data/tools-gateway';
import { ToolsPort } from '../src/data/tools.port';

// Se prueba aplicación + capa de datos real (gateway y mappers) sobre las tools mockeadas.
const svc = (tools: ToolsPort) => {
  const g = new ToolsGateway(tools, 50);
  return new AssessmentService({ data: g, actions: g, reference: REFERENCE_DATA, clock: () => NOW });
};
const rebooking = (tools: ToolsPort, s = svc(tools)) => {
  const g = new ToolsGateway(tools, 50);
  return new RebookingService(s, g, g);
};
const noMinorTrip = async () => { const t = fx().trip; t.passengers = [t.passengers[0]]; return t; };

describe('AssessmentService', () => {
  it('caso base de punta a punta con mocks', async () => {
    const a = await svc(mockTools()).assess('ABC123');
    assert.equal(a.outcome, 'HUMAN_REVIEW');
  });

  it('timeout de get_operational_events => HUMAN_REVIEW EVENTS_UNAVAILABLE (no lanza)', async () => {
    const a = await svc(mockTools({ getOperationalEvents: () => new Promise(() => undefined) })).assess('ABC123');
    assert.deepEqual(a.reasons, ['EVENTS_UNAVAILABLE']);
    assert.equal(a.communication.level, 'NONE');
  });

  it('no consulta política ni opciones si no hay modificación relevante (costo)', async () => {
    let calls = 0;
    const tools = mockTools({
      getOperationalEvents: async () => { const e = fx().events; e.events = e.events.filter((x) => x.event_id === 'E-2003'); return e; },
      getPolicyRules: async () => { calls++; return fx().policy; },
      getEligibleOptions: async () => { calls++; return fx().options; },
    });
    const a = await svc(tools).assess('ABC123');
    assert.equal(a.outcome, 'NO_ACTION');
    assert.equal(calls, 0);
  });

  it('si create_human_case falla, NO se notifica "una persona te contactará"', async () => {
    let notified = false;
    const tools = mockTools({
      createHumanCase: async () => { throw new Error('DOWN'); },
      notifyPassenger: async () => { notified = true; return { status: 202, notification_id: 'x' }; },
    });
    const s = svc(tools);
    const r = await s.act(await s.assess('ABC123'));
    assert.deepEqual(r.notification, { skipped: 'HUMAN_CASE_NOT_CREATED' });
    assert.equal(notified, false);
  });

  it('act() crea caso y luego notifica con policy_ref', async () => {
    const s = svc(mockTools());
    const r = await s.act(await s.assess('ABC123'));
    assert.deepEqual(r.humanCase, { caseId: 'HC-4471', queue: 'DISRUPTION_L2', slaMinutes: 45 });
    assert.deepEqual(r.notification, { notificationId: 'NT-9912' });
  });
});

describe('notify_passenger (enunciado: no debe enviar información no validada)', () => {
  it('toda notificación sale con policy_ref de la política evaluada y en el formato de la tool', async () => {
    const sent: unknown[] = [];
    const tools = mockTools({ notifyPassenger: async (m) => { sent.push(m); return { status: 202, notification_id: 'NT-1' }; } });
    const s = svc(tools);
    await s.act(await s.assess('ABC123'));
    assert.equal(sent.length, 1);
    assert.deepEqual(Object.keys(sent[0] as object).sort(), ['booking_id', 'params', 'policy_ref', 'template_id']);
    assert.equal((sent[0] as { policy_ref: string }).policy_ref, 'POL-DELAY-2026-03');
  });

  it('si la tool responde 422 UNVALIDATED_CONTENT se reporta como error, nunca como enviada', async () => {
    const tools = mockTools({ notifyPassenger: async () => ({ status: 422, error: 'UNVALIDATED_CONTENT' }) });
    const s = svc(tools);
    const r = await s.act(await s.assess('ABC123'));
    assert.deepEqual(r.notification, { error: 'UNVALIDATED_CONTENT' });
  });

  it('el mock reproduce el contrato: sin policy_ref responde 422', async () => {
    const r = await mockTools().notifyPassenger({ booking_id: 'ABC123', template_id: 'X', policy_ref: '', params: {} });
    assert.equal(r.status, 422);
  });
});

describe('RebookingService', () => {
  const noMinor = { getTripContext: noMinorTrip };

  it('con menor (R5) => REJECTED APPROVAL_REQUIRED y create_rebooking_request nunca se invoca', async () => {
    let rebookingCalled = false;
    const tools = mockTools({ createRebookingRequest: async () => { rebookingCalled = true; return { status: 503 }; } });
    const rb = rebooking(tools);
    assert.deepEqual(await rb.confirm('ABC123', 'O1'), { status: 'REJECTED', reason: 'APPROVAL_REQUIRED' });
    assert.equal(rebookingCalled, false);
  });

  it('un caseId real obtenido con act() no sirve como auto-aprobación', async () => {
    let rebookingCalled = false;
    const tools = mockTools({ createRebookingRequest: async () => { rebookingCalled = true; return { status: 503 }; } });
    const s = svc(tools);
    const executed = await s.act(await s.assess('ABC123'));
    assert.ok(executed.humanCase && 'caseId' in executed.humanCase); // el cliente sí recibe un caseId...
    // ...pero confirm no acepta aprobaciones del cliente: argumentos extra se ignoran y se rechaza igual.
    const r = await (rebooking(tools, s).confirm as (...args: unknown[]) => Promise<unknown>)('ABC123', 'O1', { caseId: executed.humanCase.caseId });
    assert.deepEqual(r, { status: 'REJECTED', reason: 'APPROVAL_REQUIRED' });
    assert.equal(rebookingCalled, false);
  });

  // Tarifa reembolsable y O3 (REFUND) con confianza HIGH y la política vigente: solo le falta el derecho.
  const refundableTools = (extraRule = false, onRebook: () => void = () => undefined) => mockTools({
    getTripContext: async () => { const t = await noMinorTrip(); t.fare_conditions.refundable = true; return t; },
    getEligibleOptions: async () => { const o = fx().options; Object.assign(o.options[2], { policy_ref: 'POL-DELAY-2026-03', confidence: 'HIGH' }); return o; },
    getPolicyRules: async () => {
      const p = fx().policy;
      if (extraRule) p.rules.push({ rule_id: 'R9', condition: 'missed_connection == true', entitlement: 'REFUND', requires_human_approval: false });
      return p;
    },
    createRebookingRequest: async () => { onRebook(); return { status: 201, request_id: 'RBK-X', request_status: 'PENDING_CONFIRMATION', expires_at: 'x' }; },
  });

  it('REFUND sin derecho de política => solo agente (AGENT_ONLY), no se confirma automáticamente', async () => {
    let rebookingCalled = false;
    const tools = refundableTools(false, () => { rebookingCalled = true; });
    const a = await svc(tools).assess('ABC123');
    const o3 = a.options.find((o) => o.optionId === 'O3');
    assert.equal(o3?.status, 'AGENT_ONLY');
    assert.ok(o3?.reasons.includes('NO_ENTITLEMENT'));
    assert.deepEqual(await rebooking(tools).confirm('ABC123', 'O3'), { status: 'REJECTED', reason: 'OPTION_NOT_OFFERABLE' });
    assert.equal(rebookingCalled, false);
  });

  it('aun con REFUND ofrecible, confirm nunca lo envía a create_rebooking_request (solo reprograma)', async () => {
    let rebookingCalled = false;
    const tools = refundableTools(true, () => { rebookingCalled = true; });
    assert.equal((await svc(tools).assess('ABC123')).options.find((o) => o.optionId === 'O3')?.status, 'OFFERABLE');
    assert.deepEqual(await rebooking(tools).confirm('ABC123', 'O3'), { status: 'REJECTED', reason: 'OPTION_NOT_OFFERABLE' });
    assert.equal(rebookingCalled, false);
  });

  it('opción no ofrecible (O2) se rechaza aunque el cliente la pida', async () => {
    const tools = mockTools(noMinor);
    assert.deepEqual(await rebooking(tools).confirm('ABC123', 'O2'), { status: 'REJECTED', reason: 'OPTION_NOT_OFFERABLE' });
  });

  it('doble click / reentrega: segunda llamada recibe 409 y se trata como éxito idempotente', async () => {
    const tools = mockTools(noMinor);
    const rb = rebooking(tools);
    const first = await rb.confirm('ABC123', 'O1');
    const second = await rb.confirm('ABC123', 'O1');
    assert.equal(first.status, 'PENDING_CONFIRMATION');
    assert.deepEqual(second, { status: 'ALREADY_REQUESTED', requestId: (first as any).requestId });
  });

  it('503 y reintento con la MISMA clave', async () => {
    const keys: string[] = [];
    const tools = mockTools({
      ...noMinor,
      createRebookingRequest: async (_o, k) => {
        keys.push(k);
        return keys.length === 1 ? { status: 503 } : { status: 201, request_id: 'RBK-1', request_status: 'PENDING_CONFIRMATION', expires_at: 'x' };
      },
    });
    const r = await rebooking(tools).confirm('ABC123', 'O1');
    assert.equal(r.status, 'PENDING_CONFIRMATION');
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  it('get_trip_context falla al armar la clave => REJECTED TRIP_UNAVAILABLE, sin escribir ni lanzar', async () => {
    let calls = 0;
    let rebookingCalled = false;
    const tools = mockTools({
      getTripContext: async () => { if (++calls > 1) throw new Error('DOWN'); return noMinorTrip(); },
      createRebookingRequest: async () => { rebookingCalled = true; return { status: 503 }; },
    });
    const r = await rebooking(tools).confirm('ABC123', 'O1');
    assert.deepEqual(r, { status: 'REJECTED', reason: 'TRIP_UNAVAILABLE' });
    assert.equal(rebookingCalled, false);
  });

  it('503 persistente => INDETERMINATE + caso humano (sin afirmar éxito ni fallo)', async () => {
    let caseReason = '';
    const tools = mockTools({
      ...noMinor,
      createRebookingRequest: async () => ({ status: 503 }),
      createHumanCase: async (reason) => { caseReason = reason; return { case_id: 'HC-9', queue: 'Q', sla_minutes: 45 }; },
    });
    const r = await rebooking(tools).confirm('ABC123', 'O1');
    assert.deepEqual(r, { status: 'INDETERMINATE', humanCaseId: 'HC-9' });
    assert.equal(caseReason, 'REBOOKING_INDETERMINATE');
  });
});
