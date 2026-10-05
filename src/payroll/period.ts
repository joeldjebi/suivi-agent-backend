import { PayPeriod } from '@suivi/shared';

export interface Period {
  start: string;
  end: string;
}

const parse = (d: string) => new Date(`${d}T12:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: string, n: number) =>
  iso(new Date(parse(d).getTime() + n * 86400_000));

/** Période de paie qui contient la date (dates de la structure, bornes incluses). */
export function periodFor(kind: PayPeriod, date: string): Period {
  const d = parse(date);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const last = iso(new Date(Date.UTC(y, m + 1, 0, 12)));
  const first = iso(new Date(Date.UTC(y, m, 1, 12)));
  if (kind === PayPeriod.Monthly) return { start: first, end: last };
  if (kind === PayPeriod.Biweekly) {
    return d.getUTCDate() <= 15
      ? { start: first, end: addDays(first, 14) }
      : { start: addDays(first, 15), end: last };
  }
  // Semaine du lundi au dimanche.
  const weekday = (d.getUTCDay() + 6) % 7;
  const start = addDays(date, -weekday);
  return { start, end: addDays(start, 6) };
}

/** Période précédant celle qui contient la date. */
export function previousPeriod(kind: PayPeriod, date: string): Period {
  return periodFor(kind, addDays(periodFor(kind, date).start, -1));
}

/** « septembre 2026 », « 1–15 octobre 2026 », « semaine du 28 sept. » */
export function periodLabel(kind: PayPeriod, p: Period): string {
  const month = new Intl.DateTimeFormat('fr-FR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const day = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  if (kind === PayPeriod.Monthly) return month.format(parse(p.start));
  if (kind === PayPeriod.Biweekly)
    return `${parse(p.start).getUTCDate()}–${parse(p.end).getUTCDate()} ${month.format(parse(p.start))}`;
  return `semaine du ${day.format(parse(p.start))}`;
}
