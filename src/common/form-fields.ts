import {
  FieldType,
  type MissionField,
  ProductMeasure,
  ProductScope,
} from '@suivi/shared';
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

/** Produits autorisés pour chaque champ « relevé par produit », par clé de champ. */
export type ProductsByField = Record<string, Set<string>>;

/**
 * Vérifie les valeurs saisies par rapport aux champs du type (RG-13) ; les clés inconnues sont
 * ignorées. Un relevé par produit n'est accepté que si ses produits sont fournis.
 */
export function validateData(
  fields: MissionField[],
  data: Record<string, unknown>,
  products: ProductsByField = {},
) {
  const clean: Record<string, unknown> = {};
  for (const field of fields) {
    let value = data[field.key];
    if (field.type === FieldType.Products && value != null)
      value = cleanReadings(field, value, products[field.key]);
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
        UUID.test(value)) ||
      field.type === FieldType.Products;
    if (!ok)
      throw badRequest(
        'INVALID_FORM',
        `Valeur invalide pour « ${field.label} »`,
      );
    clean[field.key] = value;
  }
  return clean;
}

const QUANTITIES = new Set<string>([
  ProductMeasure.Stock,
  ProductMeasure.Price,
  ProductMeasure.Sold,
  ProductMeasure.Losses,
  ProductMeasure.Ordered,
]);

/**
 * Relevé par produit : { produit: { mesure: valeur } }. Produits et mesures du champ
 * seulement ; quantités et prix positifs, présence en oui/non. Les produits sans aucune
 * mesure sont retirés ; null si rien n'a été relevé.
 */
function cleanReadings(
  field: MissionField,
  value: unknown,
  allowed: Set<string> | undefined,
): Record<string, Record<string, number | boolean>> | null {
  const invalid = () =>
    badRequest('INVALID_FORM', `Valeur invalide pour « ${field.label} »`);
  if (!allowed || typeof value !== 'object' || Array.isArray(value))
    throw invalid();
  const measures = new Set<string>(field.products?.measures ?? []);
  const out: Record<string, Record<string, number | boolean>> = {};
  for (const [productId, raw] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (!allowed.has(productId) || typeof raw !== 'object' || !raw)
      throw invalid();
    const row: Record<string, number | boolean> = {};
    for (const [measure, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined || v === '') continue;
      if (!measures.has(measure)) throw invalid();
      const ok =
        measure === ProductMeasure.Presence
          ? typeof v === 'boolean'
          : QUANTITIES.has(measure) &&
            typeof v === 'number' &&
            Number.isFinite(v) &&
            v >= 0 &&
            v <= 1e9;
      if (!ok) throw invalid();
      row[measure] = v as number | boolean;
    }
    if (Object.keys(row).length) out[productId] = row;
  }
  return Object.keys(out).length ? out : null;
}

export function assertFields(fields: MissionField[]) {
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key))
      throw badRequest('DUPLICATE_FIELD', `Champ en double : ${field.key}`);
    keys.add(field.key);
    if (field.type === FieldType.Products) {
      const config = field.products;
      if (
        !config ||
        !Object.values(ProductScope).includes(config.scope) ||
        !config.measures?.length ||
        config.measures.some(
          (m) => !(Object.values(ProductMeasure) as string[]).includes(m),
        ) ||
        (config.scope === ProductScope.Selected && !config.productIds?.length)
      )
        throw badRequest(
          'INVALID_PRODUCTS_FIELD',
          `Le relevé « ${field.label} » doit préciser ses produits et au moins une mesure`,
        );
    }
    if (field.type === FieldType.Select && !field.options?.length) {
      throw badRequest(
        'MISSING_OPTIONS',
        `Le champ ${field.key} doit proposer des options`,
      );
    }
  }
}
