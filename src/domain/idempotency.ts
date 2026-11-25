import { createHash } from 'node:crypto';

/**
 * Clave determinística: misma reserva + opción + versión de política + pasajeros => misma clave.
 * Reintentos (timeouts, doble click, reentrega) reutilizan la clave y el backend deduplica (409).
 */
export function buildIdempotencyKey(p: { bookingId: string; optionId: string; policyVersion: string; passengerIds: string[] }): string {
  const raw = [p.bookingId, p.optionId, p.policyVersion, [...p.passengerIds].sort().join(',')].join('|');
  return 'rbk_' + createHash('sha256').update(raw).digest('hex').slice(0, 32);
}
