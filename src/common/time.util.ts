/** Heure locale (minutes depuis minuit) et date locale d'un instant dans un fuseau donné. */
function localParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

export function parseHourMinute(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Date de travail : la journée commence à l'heure de remise à zéro de la structure
 * (RG-22). Avec une remise à 04:00, 02:00 appartient encore à la veille.
 */
export function workDate(
  now: Date,
  timeZone: string,
  resetTime: string,
): string {
  const { date, minutes } = localParts(now, timeZone);
  if (minutes >= parseHourMinute(resetTime)) return date;
  const previous = new Date(`${date}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

/** Date calendaire (AAAA-MM-JJ) d'un instant dans le fuseau de la structure. */
export function localDate(at: Date, timeZone: string): string {
  return localParts(at, timeZone).date;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}
