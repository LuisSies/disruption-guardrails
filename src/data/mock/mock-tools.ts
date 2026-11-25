import { ToolsPort } from '../tools.port';
import { fx } from './fixtures';

/** Mock con contratos del enunciado. Idempotencia simulada: misma clave => 409 con el mismo request_id. */
export function mockTools(overrides: Partial<ToolsPort> = {}): ToolsPort {
  const seen = new Map<string, string>();
  let seq = 88231;
  const base: ToolsPort = {
    async getTripContext(bookingId) {
      if (bookingId !== 'ABC123') throw new Error('NOT_FOUND');
      return fx().trip;
    },
    async getOperationalEvents() { return fx().events; },
    async getEligibleOptions() { return fx().options; },
    async getPolicyRules(scenario) {
      if (scenario !== 'DELAY') throw new Error('SCENARIO_NOT_SUPPORTED');
      return fx().policy;
    },
    async createRebookingRequest(_option, key) {
      const prev = seen.get(key);
      if (prev) return { status: 409, request_id: prev };
      const id = `RBK-${seq++}`;
      seen.set(key, id);
      return { status: 201, request_id: id, request_status: 'PENDING_CONFIRMATION', expires_at: '2026-09-15T11:12:00Z' };
    },
    async createHumanCase() { return { case_id: 'HC-4471', queue: 'DISRUPTION_L2', sla_minutes: 45 }; },
    async notifyPassenger(m) {
      return m.policy_ref ? { status: 202, notification_id: 'NT-9912' } : { status: 422, error: 'UNVALIDATED_CONTENT' };
    },
  };
  return { ...base, ...overrides };
}
