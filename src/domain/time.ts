const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Minutos "locales ingenuos" desde epoch. Solo es válido comparar valores expresados en
 * la MISMA zona (p.ej. llegada a LIM vs. salida desde LIM). Nunca mezclar con timestamps UTC.
 */
export function localMinutes(date: string, hhmm: string, dayOffset = 0): number {
  const m = HHMM.exec(hhmm);
  if (!DATE.test(date) || !m) throw new Error(`INVALID_LOCAL_TIME:${date} ${hhmm}`);
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) throw new Error(`INVALID_LOCAL_TIME:${date}`);
  return base / 60000 + dayOffset * 1440 + Number(m[1]) * 60 + Number(m[2]);
}

export function formatLocal(mins: number): string {
  const iso = new Date(mins * 60000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function ageMinutes(isoUtc: string, now: Date): number {
  const t = Date.parse(isoUtc);
  if (Number.isNaN(t)) throw new Error(`INVALID_TIMESTAMP:${isoUtc}`);
  return (now.getTime() - t) / 60000;
}
