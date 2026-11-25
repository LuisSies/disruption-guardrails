import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { AssessmentService } from '../src/application/assessment.service';
import { fromTrip, toTrip } from '../src/data/mappers';
import { NOW, fx } from '../src/data/mock/fixtures';
import { mockTools } from '../src/data/mock/mock-tools';
import { REFERENCE_DATA } from '../src/data/reference/airports';
import { ToolsGateway } from '../src/data/tools-gateway';
import { TripContext } from '../src/data/contracts';

// PII del ejemplo del enunciado (María Silva / Tomás Silva).
const PII = ['María', 'Tomás', 'Silva', 'maria.silva@example.com', '+56 9 8765 4321', '12.345.678-9', 'GOLD'];
const assertNoPii = (value: unknown) => {
  const s = JSON.stringify(value);
  for (const pii of PII) assert.ok(!s.includes(pii), `contiene PII: ${pii}`);
};

describe('capa de datos: mappers y PII', () => {
  it('toTrip descarta la PII: el modelo de dominio no tiene nombre, email, teléfono, documento ni loyalty', () => {
    const trip = toTrip(fx().trip);
    assertNoPii(trip);
    assert.deepEqual(trip.passengers, [
      { id: 'P1', type: 'ADULT', age: undefined },
      { id: 'P2', type: 'CHILD', age: 7 },
    ]);
  });

  it('toTrip traduce las rutas de campos faltantes al modelo de dominio', () => {
    assert.deepEqual(toTrip(fx().trip).missingFields, ['fareConditions.changePenaltyAmount']);
  });

  it('fromTrip (lo que se envía a get_eligible_options) no contiene PII y conserva lo necesario', () => {
    const sent = fromTrip(toTrip(fx().trip));
    assertNoPii(sent);
    assert.deepEqual(sent.passengers.map((p) => p.passenger_id), ['P1', 'P2']);
    // Se compara serializado (es lo que viaja): un campo undefined equivale a uno ausente.
    const json = (v: unknown) => JSON.parse(JSON.stringify(v));
    assert.deepEqual(json(sent.segments), json(fx().trip.segments));
    assert.deepEqual(json(sent.fare_conditions), json(fx().trip.fare_conditions));
  });

  it('de punta a punta: get_eligible_options recibe el trip_context sin PII', async () => {
    let received: TripContext | undefined;
    const tools = mockTools({ getEligibleOptions: async (t) => { received = t; return fx().options; } });
    const g = new ToolsGateway(tools, 50);
    await new AssessmentService({ data: g, actions: g, reference: REFERENCE_DATA, clock: () => NOW }).assess('ABC123');
    assert.ok(received, 'get_eligible_options no fue invocada');
    assertNoPii(received);
  });

  it('una reserva sin listas no rompe el mapper: el dominio la marca TRIP_INCOMPLETE (no TRIP_UNAVAILABLE)', async () => {
    const broken = { ...fx().trip, passengers: undefined, segments: undefined } as unknown as TripContext;
    const g = new ToolsGateway(mockTools({ getTripContext: async () => broken }), 50);
    const a = await new AssessmentService({ data: g, actions: g, reference: REFERENCE_DATA, clock: () => NOW }).assess('ABC123');
    assert.deepEqual(a.reasons, ['TRIP_INCOMPLETE']);
  });
});
