import { FieldType, type MissionField } from '@suivi/shared';
import { badRequest } from './business.exception';

/**
 * Champs personnalisés définis par la structure : formulaires de mission et fiche des points
 * de vente (mêmes types de champs, mêmes règles).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Identifiants des photos d'un formulaire (champs de type photo). */
export function photoIdsOf(
  fields: MissionField[],
  data: Record<string, unknown>,
) {
  return fields
    .filter((f) => f.type === FieldType.Photo)
    .map((f) => data[f.key])
    .filter((v): v is string => typeof v === 'string' && UUID.test(v));
}

/** Vérifie les valeurs saisies par rapport aux champs du type (RG-13) ; les clés inconnues sont ignorées. */
export function validateData(
  fields: MissionField[],
  data: Record<string, unknown>,
) {
  const clean: Record<string, unknown> = {};
  for (const field of fields) {
    const value = data[field.key];
    if (value === undefined || value === null || value === '') {
      if (field.required)
        throw badRequest(
          'INVALID_FORM',
          `Le champ « ${field.label} » est obligatoire`,
        );
      continue;
    }
    const ok =
      (field.type === FieldType.Text && typeof value === 'string') ||
      (field.type === FieldType.Number &&
        typeof value === 'number' &&
        Number.isFinite(value)) ||
      (field.type === FieldType.Boolean && typeof value === 'boolean') ||
      (field.type === FieldType.Date &&
        typeof value === 'string' &&
        !Number.isNaN(Date.parse(value))) ||
      (field.type === FieldType.Select &&
        typeof value === 'string' &&
        !!field.options?.includes(value)) ||
      (field.type === FieldType.Photo &&
        typeof value === 'string' &&
        UUID.test(value));
    if (!ok)
      throw badRequest(
        'INVALID_FORM',
        `Valeur invalide pour « ${field.label} »`,
      );
    clean[field.key] = value;
  }
  return clean;
}

export function assertFields(fields: MissionField[]) {
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key))
      throw badRequest('DUPLICATE_FIELD', `Champ en double : ${field.key}`);
    keys.add(field.key);
    if (field.type === FieldType.Select && !field.options?.length) {
      throw badRequest(
        'MISSING_OPTIONS',
        `Le champ ${field.key} doit proposer des options`,
      );
    }
  }
}
