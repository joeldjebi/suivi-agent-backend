import { badRequest } from './business.exception';

/** Indicatif par défaut (Côte d'Ivoire). */
export const DEFAULT_COUNTRY_CODE = '225';

/**
 * Normalise un numéro au format international (+2250707070707), pour comparer
 * « 07 07 07 07 07 », « 0707070707 » et « +225 07 07 07 07 07 ». Renvoie null si invalide.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim().replace(/[\s.\-()]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) value = `+${DEFAULT_COUNTRY_CODE}${value}`;
  return /^\+\d{8,15}$/.test(value) ? value : null;
}

export function requirePhone(raw: string | null | undefined): string {
  const phone = normalizePhone(raw);
  if (!phone) {
    throw badRequest(
      'INVALID_PHONE',
      'Numéro de téléphone invalide (ex. : 07 07 07 07 07 ou +225 07 07 07 07 07)',
    );
  }
  return phone;
}
