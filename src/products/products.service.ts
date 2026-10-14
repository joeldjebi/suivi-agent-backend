import { Injectable } from '@nestjs/common';
import {
  type MissionField,
  type Packaging,
  ProductMeasure,
  ProductScope,
  FieldType,
  type ProductFieldConfig,
} from '@suivi/shared';
import { badRequest, notFound } from '../common/business.exception';
import { number, plain, readSheet } from '../common/sheet-read';
import type { ExportFile } from '../exports/exports.service';
import { type Sheet, toXlsx } from '../exports/sheet';
import { DbService } from '../common/db.service';
import type {
  CreateProductDto,
  ListProductsQuery,
  UpdateProductDto,
} from './products.dto';

export interface Product {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  format: string | null;
  own: boolean;
  unit: string;
  packagings: Packaging[];
  isActive: boolean;
}

const SELECT = `id, name, brand, category, format, own, unit, packagings, is_active AS "isActive"`;

/**
 * Catalogue de produits de la structure (les siens et ceux de la concurrence) : unité de base
 * et conditionnements. Les relevés en stockent les quantités en unités de base.
 */
@Injectable()
export class ProductsService {
  constructor(private readonly db: DbService) {}

  list(q: ListProductsQuery = {}): Promise<Product[]> {
    return this.db.manager.query<Product[]>(
      `SELECT ${SELECT} FROM products
       WHERE ($1 OR is_active)
         AND ($2::text IS NULL OR own = ($2 = 'own'))
       ORDER BY own DESC, category NULLS LAST, name`,
      [q.includeInactive ?? false, q.side ?? null],
    );
  }

  async get(id: string): Promise<Product> {
    const [row] = await this.db.manager.query<Product[]>(
      `SELECT ${SELECT} FROM products WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('Produit');
    return row;
  }

  async create(dto: CreateProductDto) {
    const [{ id }] = await this.db.manager.query<{ id: string }[]>(
      `INSERT INTO products (tenant_id, name, brand, category, format, own, unit, packagings)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING id`,
      [
        this.db.tenantId,
        dto.name,
        dto.brand || null,
        dto.category || null,
        dto.format || null,
        dto.own,
        dto.unit,
        JSON.stringify(normalizePackagings(dto.packagings ?? [])),
      ],
    );
    return this.get(id);
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.get(id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.brand !== undefined) set('brand', dto.brand || null);
    if (dto.category !== undefined) set('category', dto.category || null);
    if (dto.format !== undefined) set('format', dto.format || null);
    if (dto.own !== undefined) set('own', dto.own);
    if (dto.unit !== undefined) set('unit', dto.unit);
    if (dto.packagings !== undefined)
      set(
        'packagings',
        JSON.stringify(normalizePackagings(dto.packagings)),
        '::jsonb',
      );
    if (dto.isActive !== undefined) set('is_active', dto.isActive);
    if (sets.length)
      await this.db.manager.query(
        `UPDATE products SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
        params,
      );
    return this.get(id);
  }

  /** Suppression : seulement un produit jamais relevé (sinon, le désactiver). */
  async remove(id: string) {
    await this.get(id);
    const [{ used }] = await this.db.manager.query<{ used: number }[]>(
      `SELECT count(*)::int AS used FROM product_readings WHERE product_id = $1`,
      [id],
    );
    if (used)
      throw badRequest(
        'PRODUCT_IN_USE',
        'Ce produit a déjà été relevé : désactivez-le plutôt que de le supprimer',
      );
    await this.db.manager.query(`DELETE FROM products WHERE id = $1`, [id]);
  }

  /** Modèle d'import du catalogue, avec deux lignes d'exemple. */
  async template(): Promise<ExportFile> {
    const sheet: Sheet = {
      title: 'Produits',
      columns: [
        { header: 'Nom', kind: 'text', width: 26 },
        { header: 'Marque', kind: 'text', width: 16 },
        { header: 'Catégorie', kind: 'text', width: 16 },
        { header: 'Format', kind: 'text', width: 10 },
        { header: 'Concurrent', kind: 'text', width: 11 },
        { header: 'Unité', kind: 'text', width: 12 },
        ...[1, 2, 3].flatMap((n) => [
          { header: `Conditionnement ${n}`, kind: 'text' as const, width: 18 },
          { header: `Unités ${n}`, kind: 'general' as const, width: 9 },
        ]),
      ],
      rows: [
        [
          'Coca-Cola',
          'Coca-Cola',
          'Boissons',
          '33 cl',
          'Non',
          'Bouteille',
          'Pack',
          6,
          'Casier',
          12,
          null,
          null,
        ],
        [
          'Pepsi',
          'PepsiCo',
          'Boissons',
          '33 cl',
          'Oui',
          'Bouteille',
          'Casier',
          12,
          null,
          null,
          null,
          null,
        ],
      ],
    };
    const [{ name }] = await this.db.manager.query<{ name: string }[]>(
      `SELECT name FROM tenants WHERE id = $1`,
      [this.db.tenantId],
    );
    return {
      filename: 'suivi-agent_modele-produits.xlsx',
      mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      data: await toXlsx(sheet, `Suivi Agent · ${name}`),
    };
  }

  /**
   * Import Excel ou CSV du catalogue : une ligne par produit. Les lignes invalides ou déjà
   * présentes (même nom et même format) sont écartées avec leur motif.
   */
  async import(file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length)
      throw badRequest('FILE_REQUIRED', 'Aucun fichier reçu');
    const [header, ...lines] = await readSheet(file);
    if (!header?.length) throw badRequest('EMPTY_FILE', 'Le fichier est vide');
    if (lines.length > 2000)
      throw badRequest('IMPORT_TOO_LARGE', 'Au plus 2 000 produits par import');
    const columns = header.map((h) => plain(String(h ?? '')));
    const col = (...names: string[]) =>
      columns.findIndex((c) => names.includes(c));
    const at = {
      name: col('nom', 'produit', 'nom du produit'),
      brand: col('marque'),
      category: col('categorie'),
      format: col('format', 'contenance'),
      competitor: col('concurrent'),
      unit: col('unite', 'unite de base'),
      packs: [1, 2, 3].map((n) => ({
        name: col(`conditionnement ${n}`),
        units: col(`unites ${n}`),
      })),
    };
    if (at.name < 0)
      throw badRequest(
        'MISSING_COLUMN',
        'Colonne « Nom » introuvable : utilisez le modèle d’import',
      );
    const known = new Set(
      (await this.list({ includeInactive: true })).map((p) =>
        plain(`${p.name} ${p.format ?? ''}`),
      ),
    );
    const skipped: { row: number; name: string | null; reason: string }[] = [];
    let created = 0;
    for (const [i, cells] of lines.entries()) {
      const line = i + 2;
      const text = (index: number) => {
        const v = index >= 0 ? cells[index] : null;
        const s = v === null || v === undefined ? '' : String(v).trim();
        return s || null;
      };
      if (cells.every((c) => c === null || String(c).trim() === '')) continue;
      const name = text(at.name);
      const fail = (reason: string) =>
        skipped.push({ row: line, name, reason });
      if (!name) {
        fail('Nom manquant');
        continue;
      }
      // « Concurrent » : Oui / Non (vide : produit de la structure).
      const competitor = plain(text(at.competitor) ?? 'non');
      const own = ['non', 'n', 'no', '0', 'false'].includes(competitor);
      if (!own && !['oui', 'o', 'yes', '1', 'true', 'x'].includes(competitor)) {
        fail('Concurrent : « Oui » ou « Non » attendu');
        continue;
      }
      const packagings: Packaging[] = [];
      let badPack = false;
      for (const p of at.packs) {
        const packName = text(p.name);
        if (!packName) continue;
        const units = number(p.units >= 0 ? cells[p.units] : null);
        if (!units || !Number.isInteger(units) || units < 2) badPack = true;
        else packagings.push({ name: packName.slice(0, 40), units });
      }
      if (badPack) {
        fail(
          'Conditionnement : le nombre d’unités doit être un entier d’au moins 2',
        );
        continue;
      }
      const format = text(at.format)?.slice(0, 40) ?? null;
      const key = plain(`${name} ${format ?? ''}`);
      if (known.has(key)) {
        fail('Déjà présent');
        continue;
      }
      await this.create({
        name: name.slice(0, 120),
        brand: text(at.brand)?.slice(0, 80) ?? null,
        category: text(at.category)?.slice(0, 80) ?? null,
        format,
        own,
        unit: text(at.unit)?.slice(0, 30) ?? 'Unité',
        packagings,
      });
      known.add(key);
      created++;
    }
    return {
      created,
      skipped: skipped.slice(0, 500),
      skippedCount: skipped.length,
    };
  }

  /** Produits d'un champ « relevé par produit » (actifs), dans l'ordre du catalogue. */
  async forField(config: ProductFieldConfig): Promise<Product[]> {
    const products = await this.list();
    return products.filter(
      (p) =>
        (config.scope === ProductScope.All ||
          (config.scope === ProductScope.Own && p.own) ||
          (config.scope === ProductScope.Competitor && !p.own) ||
          (config.scope === ProductScope.Selected &&
            (config.productIds ?? []).includes(p.id))) &&
        (!config.category || p.category === config.category),
    );
  }

  /** Produits de chaque champ « relevé par produit » d'un formulaire, par clé de champ. */
  async forFields(fields: MissionField[]): Promise<Record<string, Product[]>> {
    const out: Record<string, Product[]> = {};
    for (const f of fields)
      if (f.type === FieldType.Products && f.products)
        out[f.key] = await this.forField(f.products);
    return out;
  }
}

/** Conditionnements sans doublon de nom, du plus petit au plus grand. */
function normalizePackagings(list: Packaging[]): Packaging[] {
  const seen = new Set<string>();
  return list
    .filter((p) => {
      const key = p.name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p) => ({ name: p.name.trim(), units: p.units }))
    .sort((a, b) => a.units - b.units);
}

/** Mesures connues (validation des champs). */
export const MEASURES = Object.values(ProductMeasure);
