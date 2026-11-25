// Umbrales y supuestos explícitos. Cada uno es una pregunta abierta para Operaciones/Producto.
export interface Config {
  /** Retraso a partir del cual la modificación se considera relevante. */
  relevantDelayMinutes: number;
  /** Tiempo mínimo de conexión (MCT). Supuesto único; en producción es por aeropuerto/tipo de vuelo. */
  minConnectionMinutes: number;
  /** Antigüedad máxima de un evento de retraso/cancelación para comunicarlo sin revisión humana. */
  maxEventAgeMinutes: number;
  /** Antigüedad máxima de la respuesta del feed operacional respecto de "ahora". */
  maxFeedAgeSeconds: number;
  /** Diferencia tolerada entre dos fuentes confiables que reportan retraso. */
  delayToleranceMinutes: number;
  /** Campos faltantes del trip que NO bloquean (la V1 nunca cobra cambios automáticamente). */
  nonBlockingMissingFields: string[];
}

export const DEFAULT_CONFIG: Config = {
  relevantDelayMinutes: 60,
  minConnectionMinutes: 45,
  maxEventAgeMinutes: 120,
  maxFeedAgeSeconds: 300,
  delayToleranceMinutes: 15,
  nonBlockingMissingFields: ['fareConditions.changePenaltyAmount'],
};
