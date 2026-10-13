import { HttpStatus, Injectable } from '@nestjs/common';
import {
  FieldType,
  type MissionField,
  OUTLET_CATEGORIES,
  OUTLET_STATUS_LABELS,
  OutletStatus,
  Role,
} from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import {
  BusinessException,
  badRequest,
  conflict,
  forbidden,
  notFound,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { assertFields, photoIdsOf, validateData } from '../common/form-fields';
import { requirePhone } from '../common/phone';
import { AuditLog } from '../entities';
import type { ExportFile } from '../exports/exports.service';
import { type Cell, type Sheet, toCsv, toXlsx } from '../exports/sheet';
import type {
  ChangeOutletStatusDto,
  CreateOutletDto,
  ExportOutletsQuery,
  ListOutletsQuery,
  OutletsMapQuery,
  UpdateOutletDto,
} from './outlets.dto';
import { parseOutletSheet } from './outlets.import';

/** Deux fiches à moins de 25 m, ou de même nom à moins de 150 m : sans doute le même commerce. */
const DUPLICATE_NEAR_M = 25;
const DUPLICATE_SAME_NAME_M = 150;
/** Lignes d'un import, au plus */
const MAX_IMPORT_ROWS = 5000;

export interface OutletView {
  id: string;
  name: string;
  category: string | null;
  managerName: string | null;
  phone: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  status: OutletStatus;
  statusChangedAt: Date;
  photoId: string | null;
  data: Record<string, unknown>;
  zone: { id: string; name: string } | null;
  createdBy: { id: string; name: string } | null;
  createdAt: Date;
  updatedAt: Date;
  /** Distance en mètres (recherche autour d'un point) */
  distance?: number;
}

interface Row {
  id: string;
  name: string;
  category: string | null;
  managerName: string | null;
  phone: string | null;
  landmark: string | null;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  status: OutletStatus;
  statusChangedAt: Date;
  photoId: string | null;
  data: Record<string, unknown>;
  zoneId: string | null;
  zoneName: string | null;
  createdById: string | null;
  createdByName: string | null;
  createdAt: Date;
  updatedAt: Date;
  distance?: number | null;
}

/** Colonnes communes ; la zone est déduite de la position (elle suit les tracés). */
const SELECT = `
  o.id, o.name, o.category, o.manager_name AS "managerName", o.phone, o.landmark,
  ST_Y(o.location) AS lat, ST_X(o.location) AS lng, o.accuracy, o.status,
  o.status_changed_at AS "statusChangedAt", o.photo_id AS "photoId", o.data,
  zz.id AS "zoneId", zz.name AS "zoneName",
  o.created_by AS "createdById",
  nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS "createdByName",
  o.created_at AS "createdAt", o.updated_at AS "updatedAt"`;
const FROM = `
  FROM outlets o
  LEFT JOIN LATERAL (
    SELECT z.id, z.name FROM zones z
    WHERE z.is_active AND o.location IS NOT NULL AND ST_Covers(z.area, o.location)
    ORDER BY z.name LIMIT 1
  ) zz ON true
  LEFT JOIN users u ON u.id = o.created_by`;

/** Périmètre visible : `zones` null = tout ; sinon ces zones, ses fiches et celles de ses agents. */
interface Scope {
  zones: string[] | null;
  creators: string[];
}

/** Sans accents ni casse ni ponctuation : « Boutique Awa » = « boutique awa ». */
export const plainName = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * Répertoire des points de vente : identifiés sur le terrain (position GPS, photo, fiche
 * personnalisée) ou importés, avec un statut commercial et son historique. L'agent voit ceux
 * de ses zones, le chef ceux des zones de ses groupes, l'administrateur tous.
 */
@Injectable()
export class OutletsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  // ---------------------------------------------------------------- fiche

  /** Champs de la fiche définis par la structure, et types de commerce proposés. */
  async form() {
    const fields = await this.fields();
    const used = await this.db.manager.query<{ category: string }[]>(
      `SELECT DISTINCT category FROM outlets WHERE category IS NOT NULL ORDER BY category LIMIT 100`,
    );
    const categories = [...OUTLET_CATEGORIES] as string[];
    for (const { category } of used)
      if (!categories.includes(category)) categories.push(category);
    return {
      fields,
      categories,
      statuses: Object.entries(OUTLET_STATUS_LABELS).map(([value, label]) => ({
        value,
        label,
      })),
    };
  }

  async setFields(fields: MissionField[]) {
    assertFields(fields);
    await this.db.manager.query(
      `UPDATE tenant_settings SET outlet_fields = $1::jsonb WHERE tenant_id = $2`,
      [JSON.stringify(fields), this.db.tenantId],
    );
    return this.form();
  }

  /**
   * Champs de la fiche. Pour une saisie qui n'est pas celle d'un agent sur place (site web,
   * responsable), une photo obligatoire ne l'est pas : elle se prend sur le terrain.
   */
  private async fields(user?: AuthUser): Promise<MissionField[]> {
    const [row] = await this.db.manager.query<{ fields: MissionField[] }[]>(
      `SELECT outlet_fields AS fields FROM tenant_settings WHERE tenant_id = $1`,
      [this.db.tenantId],
    );
    const fields = row?.fields ?? [];
    if (!user || user.role === Role.Agent) return fields;
    return fields.map((f) =>
      f.type === FieldType.Photo ? { ...f, required: false } : f,
    );
  }

  // ---------------------------------------------------------------- lecture

  async list(user: AuthUser, q: ListOutletsQuery) {
    const scope = await this.scope(user);
    const near = q.lat != null && q.lng != null;
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [this.scopeSql(scope, p)];
    if (q.q) {
      const like = p(`%${q.q.trim()}%`);
      where.push(
        `(o.name ILIKE ${like} OR o.manager_name ILIKE ${like} OR o.phone ILIKE ${like} OR o.landmark ILIKE ${like})`,
      );
    }
    if (q.zoneId) where.push(`zz.id = ${p(q.zoneId)}`);
    if (q.category) where.push(`o.category = ${p(q.category)}`);
    if (q.unlocated) where.push(`o.location IS NULL`);
    let distance = '';
    if (near) {
      const point = `ST_SetSRID(ST_MakePoint(${p(q.lng)}, ${p(q.lat)}), 4326)`;
      distance = `ST_Distance(o.location::geography, ${point}::geography)`;
      // Rayon par défaut : 50 km (le point est ainsi utilisé par toutes les requêtes).
      where.push(
        `o.location IS NOT NULL AND ST_DWithin(o.location::geography, ${point}::geography, ${p(q.radius ?? 50_000)})`,
      );
    }
    // Compteurs par statut : avec tous les filtres sauf le statut lui-même.
    const counts = await this.db.manager.query<
      { status: OutletStatus; count: number }[]
    >(
      `SELECT o.status, count(*)::int AS count ${FROM}
       WHERE ${where.join(' AND ')} GROUP BY o.status`,
      params,
    );
    if (q.status) where.push(`o.status = ${p(q.status)}`);
    const [{ total }] = await this.db.manager.query<{ total: number }[]>(
      `SELECT count(*)::int AS total ${FROM} WHERE ${where.join(' AND ')}`,
      params,
    );
    const rows = await this.db.manager.query<Row[]>(
      `SELECT ${SELECT}${near ? `, ${distance} AS distance` : ''} ${FROM}
       WHERE ${where.join(' AND ')}
       ORDER BY ${near ? 'distance' : 'o.name'}, o.id
       LIMIT ${p(q.limit)} OFFSET ${p((q.page - 1) * q.limit)}`,
      params,
    );
    return {
      items: rows.map(view),
      total,
      page: q.page,
      limit: q.limit,
      counts: Object.fromEntries(
        Object.values(OutletStatus).map((s) => [
          s,
          counts.find((c) => c.status === s)?.count ?? 0,
        ]),
      ) as Record<OutletStatus, number>,
    };
  }

  /** Points pour la carte : tous ceux qui ont une position, en version légère. */
  async map(user: AuthUser, q: OutletsMapQuery) {
    const scope = await this.scope(user);
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [this.scopeSql(scope, p), 'o.location IS NOT NULL'];
    if (q.status) where.push(`o.status = ${p(q.status)}`);
    if (q.zoneId) where.push(`zz.id = ${p(q.zoneId)}`);
    return this.db.manager.query<
      {
        id: string;
        name: string;
        status: OutletStatus;
        lat: number;
        lng: number;
      }[]
    >(
      `SELECT o.id, o.name, o.status, o.category, ST_Y(o.location) AS lat, ST_X(o.location) AS lng
       ${FROM} WHERE ${where.join(' AND ')} ORDER BY o.name LIMIT 20000`,
      params,
    );
  }

  async get(user: AuthUser, id: string) {
    const outlet = await this.findVisible(user, id);
    const history = await this.db.manager.query<
      {
        id: string;
        fromStatus: OutletStatus | null;
        toStatus: OutletStatus;
        comment: string | null;
        createdAt: Date;
        user: { id: string; name: string } | null;
      }[]
    >(
      `SELECT h.id, h.from_status AS "fromStatus", h.to_status AS "toStatus", h.comment,
              h.created_at AS "createdAt",
              CASE WHEN u.id IS NULL THEN NULL
                   ELSE json_build_object('id', u.id, 'name', trim(u.first_name || ' ' || u.last_name)) END AS "user"
       FROM outlet_status_changes h LEFT JOIN users u ON u.id = h.user_id
       WHERE h.outlet_id = $1 ORDER BY h.created_at DESC, h.id LIMIT 100`,
      [id],
    );
    // Visites des missions : les plus récentes.
    const visits = await this.db.manager.query<
      {
        id: string;
        missionId: string;
        missionTitle: string;
        agent: string;
        submittedAt: Date;
        distance: number | null;
        status: string;
      }[]
    >(
      `SELECT s.id, m.id AS "missionId", m.title AS "missionTitle",
              trim(u.first_name || ' ' || u.last_name) AS agent,
              s.submitted_at AS "submittedAt", s.distance_m AS distance, s.status
       FROM mission_submissions s
       JOIN missions m ON m.id = s.mission_id
       JOIN users u ON u.id = s.agent_id
       WHERE s.outlet_id = $1
       ORDER BY s.submitted_at DESC LIMIT 30`,
      [id],
    );
    return { ...outlet, history, visits };
  }

  /** Point de vente visible par l'utilisateur (visite d'une mission). */
  findForVisit(user: AuthUser, id: string): Promise<OutletView> {
    return this.findVisible(user, id);
  }

  /** Position enregistrée lors d'une visite d'un point de vente qui n'en avait pas. */
  async locateFromVisit(
    outletId: string,
    lat: number,
    lng: number,
    accuracy: number | null,
    userId: string,
  ) {
    const [row] = await this.db.manager.query<{ status: OutletStatus }[]>(
      `WITH u AS (
         UPDATE outlets SET location = ST_SetSRID(ST_MakePoint($2, $3), 4326), accuracy = $4,
                updated_at = now()
         WHERE id = $1 AND location IS NULL RETURNING status
       )
       SELECT status FROM u`,
      [outletId, lng, lat, accuracy],
    );
    if (row)
      await this.history(
        outletId,
        row.status,
        row.status,
        'Localisé lors d’une visite',
        userId,
      );
  }

  /** Statut constaté pendant une visite (avec un commentaire facultatif). */
  async statusFromVisit(
    user: AuthUser,
    outlet: OutletView,
    status: OutletStatus | undefined,
    comment: string | undefined,
  ) {
    const next = status ?? outlet.status;
    if (next === outlet.status && !comment) return;
    if (next !== outlet.status)
      await this.db.manager.query(
        `UPDATE outlets SET status = $2, status_changed_at = now(), updated_at = now() WHERE id = $1`,
        [outlet.id, next],
      );
    await this.history(
      outlet.id,
      outlet.status,
      next,
      comment || null,
      user.id,
    );
  }

  private async findVisible(user: AuthUser, id: string): Promise<OutletView> {
    const scope = await this.scope(user);
    const params: unknown[] = [id];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const [row] = await this.db.manager.query<Row[]>(
      `SELECT ${SELECT} ${FROM} WHERE o.id = $1 AND ${this.scopeSql(scope, p)}`,
      params,
    );
    if (!row) throw notFound('Point de vente');
    return view(row);
  }

  // ---------------------------------------------------------------- écriture

  async create(user: AuthUser, dto: CreateOutletDto) {
    const m = this.db.manager;
    if (dto.clientId) {
      const [existing] = await m.query<{ id: string }[]>(
        `SELECT id FROM outlets WHERE client_id = $1`,
        [dto.clientId],
      );
      if (existing) return this.get(user, existing.id);
    }
    const fields = await this.fields(user);
    const data = validateData(fields, dto.data ?? {});
    const photos = [...photoIdsOf(fields, data)];
    if (dto.photoId) photos.push(dto.photoId);
    await this.assertPhotos(user, photos, null);
    await this.assertPlace(user, dto.lat, dto.lng);
    if (!dto.force) await this.assertNoDuplicate(dto.name, dto.lat, dto.lng);
    const status = dto.status ?? OutletStatus.New;
    const [{ id }] = await m.query<{ id: string }[]>(
      `INSERT INTO outlets (tenant_id, name, category, manager_name, phone, landmark, location,
                            accuracy, status, photo_id, data, created_by, client_id)
       VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), $9, $10, $11,
               $12::jsonb, $13, $14)
       RETURNING id`,
      [
        this.db.tenantId,
        dto.name,
        dto.category || null,
        dto.managerName || null,
        dto.phone ? requirePhone(dto.phone) : null,
        dto.landmark || null,
        dto.lng,
        dto.lat,
        dto.accuracy ?? null,
        status,
        dto.photoId ?? null,
        JSON.stringify(data),
        user.id,
        dto.clientId ?? null,
      ],
    );
    await this.history(id, null, status, dto.comment || null, user.id);
    await this.attachPhotos(id, photos);
    return this.get(user, id);
  }

  async update(user: AuthUser, id: string, dto: UpdateOutletDto) {
    const outlet = await this.findVisible(user, id);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (dto.name !== undefined) set('name', dto.name);
    if (dto.category !== undefined) set('category', dto.category || null);
    if (dto.managerName !== undefined)
      set('manager_name', dto.managerName || null);
    if (dto.phone !== undefined)
      set('phone', dto.phone ? requirePhone(dto.phone) : null);
    if (dto.landmark !== undefined) set('landmark', dto.landmark || null);

    const fields = await this.fields(user);
    const photos: string[] = [];
    if (dto.data !== undefined) {
      const data = validateData(fields, { ...outlet.data, ...dto.data });
      photos.push(
        ...photoIdsOf(fields, data).filter(
          (p) => !photoIdsOf(fields, outlet.data).includes(p),
        ),
      );
      set('data', JSON.stringify(data), '::jsonb');
    }
    if (dto.photoId !== undefined) {
      if (dto.photoId && dto.photoId !== outlet.photoId)
        photos.push(dto.photoId);
      set('photo_id', dto.photoId ?? null);
    }
    await this.assertPhotos(user, photos, id);

    if ((dto.lat == null) !== (dto.lng == null))
      throw badRequest(
        'INVALID_POSITION',
        'Latitude et longitude vont ensemble',
      );
    if (dto.lat != null && dto.lng != null) {
      // L'agent localise un point de vente importé sans position ; il ne déplace pas les autres.
      if (user.role === Role.Agent && outlet.lat != null)
        throw forbidden('Seul un responsable peut déplacer un point de vente');
      await this.assertPlace(user, dto.lat, dto.lng);
      params.push(dto.lng, dto.lat);
      sets.push(
        `location = ST_SetSRID(ST_MakePoint($${params.length - 1}, $${params.length}), 4326)`,
      );
      set('accuracy', dto.accuracy ?? null);
    }
    if (sets.length) {
      await this.db.manager.query(
        `UPDATE outlets SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
        params,
      );
    }
    await this.attachPhotos(id, photos);
    return this.get(user, id);
  }

  /** Nouveau statut (avec un commentaire facultatif) ; un commentaire seul est aussi noté. */
  async changeStatus(user: AuthUser, id: string, dto: ChangeOutletStatusDto) {
    const outlet = await this.findVisible(user, id);
    if (dto.status === outlet.status && !dto.comment) return this.get(user, id);
    if (dto.status !== outlet.status) {
      await this.db.manager.query(
        `UPDATE outlets SET status = $2, status_changed_at = now(), updated_at = now() WHERE id = $1`,
        [id, dto.status],
      );
    }
    await this.history(
      id,
      outlet.status,
      dto.status,
      dto.comment || null,
      user.id,
    );
    return this.get(user, id);
  }

  async remove(id: string) {
    const [row] = await this.db.manager.query<{ id: string }[]>(
      `DELETE FROM outlets WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!row) throw notFound('Point de vente');
  }

  /**
   * Fusion de deux fiches du même commerce : l'historique et les photos passent sur la fiche
   * conservée, qui reprend les informations qui lui manquaient ; l'autre est supprimée.
   */
  async merge(user: AuthUser, id: string, intoId: string) {
    if (id === intoId)
      throw badRequest('SAME_OUTLET', 'Choisissez un autre point de vente');
    const source = await this.findVisible(user, id);
    const target = await this.findVisible(user, intoId);
    const m = this.db.manager;
    await m.query(
      `UPDATE outlets t SET
         category = coalesce(t.category, s.category),
         manager_name = coalesce(t.manager_name, s.manager_name),
         phone = coalesce(t.phone, s.phone),
         landmark = coalesce(t.landmark, s.landmark),
         location = coalesce(t.location, s.location),
         accuracy = CASE WHEN t.location IS NULL THEN s.accuracy ELSE t.accuracy END,
         photo_id = coalesce(t.photo_id, s.photo_id),
         data = s.data || t.data,
         updated_at = now()
       FROM outlets s WHERE t.id = $1 AND s.id = $2`,
      [intoId, id],
    );
    await m.query(
      `UPDATE outlet_status_changes SET outlet_id = $1 WHERE outlet_id = $2`,
      [intoId, id],
    );
    await m.query(
      `UPDATE submission_photos SET outlet_id = $1 WHERE outlet_id = $2`,
      [intoId, id],
    );
    // Visites et listes de missions : elles suivent la fiche conservée.
    await m.query(
      `UPDATE mission_submissions SET outlet_id = $1 WHERE outlet_id = $2`,
      [intoId, id],
    );
    await m.query(
      `INSERT INTO mission_outlets (tenant_id, mission_id, outlet_id)
       SELECT tenant_id, mission_id, $1 FROM mission_outlets WHERE outlet_id = $2
       ON CONFLICT DO NOTHING`,
      [intoId, id],
    );
    await m.query(`DELETE FROM outlets WHERE id = $1`, [id]);
    await this.history(
      intoId,
      target.status,
      target.status,
      `Fiche « ${source.name} » fusionnée`,
      user.id,
    );
    return this.get(user, intoId);
  }

  // ---------------------------------------------------------------- import / export

  /** Modèle d'import : colonnes de base et champs de la fiche, avec une ligne d'exemple. */
  async template(): Promise<ExportFile> {
    const fields = (await this.fields()).filter((f) => f.type !== 'photo');
    const sheet: Sheet = {
      title: 'Points de vente',
      columns: [
        { header: 'Nom', kind: 'text', width: 26 },
        { header: 'Type', kind: 'text', width: 16 },
        { header: 'Gérant', kind: 'text', width: 20 },
        { header: 'Téléphone', kind: 'text', width: 18 },
        { header: 'Repère', kind: 'text', width: 30 },
        { header: 'Latitude', kind: 'general', width: 12 },
        { header: 'Longitude', kind: 'general', width: 12 },
        { header: 'Statut', kind: 'text', width: 14 },
        ...fields.map((f) => ({ header: f.label, kind: 'text' as const })),
      ],
      rows: [
        [
          'Boutique Awa',
          'Boutique',
          'Awa Koné',
          '07 07 07 07 07',
          'En face de la pharmacie du marché',
          5.3599,
          -4.0083,
          'Prospect',
          ...fields.map(() => null),
        ],
      ],
    };
    return this.file(sheet, 'modele-points-de-vente', 'xlsx');
  }

  /**
   * Import Excel ou CSV : une ligne par point de vente. Les lignes invalides ou déjà
   * présentes sont écartées avec leur motif ; la position est facultative (« à localiser »).
   */
  async import(user: AuthUser, file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length)
      throw badRequest('FILE_REQUIRED', 'Aucun fichier reçu');
    const fields = (await this.fields()).filter((f) => f.type !== 'photo');
    const parsed = await parseOutletSheet(file, fields);
    if (parsed.rows.length > MAX_IMPORT_ROWS)
      throw badRequest(
        'IMPORT_TOO_LARGE',
        `Au plus ${MAX_IMPORT_ROWS.toLocaleString('fr-FR')} points de vente par import`,
      );
    const m = this.db.manager;
    const skipped = [...parsed.skipped];
    // Déjà présents : même nom à moins de 25 m, ou même nom et même téléphone.
    const existing = await m.query<
      {
        name: string;
        phone: string | null;
        lat: number | null;
        lng: number | null;
      }[]
    >(
      `SELECT name, phone, ST_Y(location) AS lat, ST_X(location) AS lng FROM outlets`,
    );
    const known = existing.map((e) => ({ ...e, plain: plainName(e.name) }));
    let created = 0;
    for (const row of parsed.rows) {
      const plain = plainName(row.name);
      const twin = known.find(
        (k) =>
          k.plain === plain &&
          ((row.phone && k.phone === row.phone) ||
            (row.lat != null &&
              k.lat != null &&
              distanceM(row.lat, row.lng!, k.lat, k.lng!) <=
                DUPLICATE_NEAR_M) ||
            (row.lat == null && k.lat == null && !row.phone && !k.phone)),
      );
      if (twin) {
        skipped.push({ row: row.line, name: row.name, reason: 'Déjà présent' });
        continue;
      }
      const [{ id }] = await m.query<{ id: string }[]>(
        `INSERT INTO outlets (tenant_id, name, category, manager_name, phone, landmark,
                              location, status, data, created_by)
         VALUES ($1, $2, $3, $4, $5, $6,
                 CASE WHEN $7::float8 IS NULL THEN NULL
                      ELSE ST_SetSRID(ST_MakePoint($8::float8, $7::float8), 4326) END,
                 $9, $10::jsonb, $11)
         RETURNING id`,
        [
          this.db.tenantId,
          row.name,
          row.category,
          row.managerName,
          row.phone,
          row.landmark,
          row.lat,
          row.lng,
          row.status,
          JSON.stringify(row.data),
          user.id,
        ],
      );
      await this.history(id, null, row.status, 'Importé', user.id);
      known.push({ ...row, plain });
      created++;
    }
    return {
      created,
      skipped: skipped.sort((a, b) => a.row - b.row).slice(0, 500),
      skippedCount: skipped.length,
    };
  }

  async export(
    user: AuthUser,
    q: ExportOutletsQuery,
    path: string,
    ip?: string,
  ): Promise<ExportFile> {
    const scope = await this.scope(user);
    const settings = await this.access.settings();
    const fields = (await this.fields()).filter((f) => f.type !== 'photo');
    const params: unknown[] = [];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const where = [this.scopeSql(scope, p)];
    if (q.status) where.push(`o.status = ${p(q.status)}`);
    if (q.zoneId) where.push(`zz.id = ${p(q.zoneId)}`);
    const tz = p(settings.timezone);
    const rows = await this.db.manager.query<
      (Row & { created: string; changed: string })[]
    >(
      `SELECT ${SELECT},
              to_char(o.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS created,
              to_char(o.status_changed_at AT TIME ZONE ${tz}, 'YYYY-MM-DD HH24:MI') AS changed
       ${FROM} WHERE ${where.join(' AND ')} ORDER BY o.name LIMIT 50001`,
      params,
    );
    if (rows.length > 50_000)
      throw badRequest(
        'EXPORT_TOO_LARGE',
        'Plus de 50 000 lignes : filtrez par zone ou par statut',
      );
    const sheet: Sheet = {
      title: 'Points de vente',
      columns: [
        { header: 'Nom', kind: 'text', width: 26 },
        { header: 'Type', kind: 'text', width: 16 },
        { header: 'Statut', kind: 'text', width: 14 },
        { header: 'Zone', kind: 'text', width: 16 },
        { header: 'Gérant', kind: 'text', width: 20 },
        { header: 'Téléphone', kind: 'text', width: 18 },
        { header: 'Repère', kind: 'text', width: 30 },
        { header: 'Latitude', kind: 'general', width: 12 },
        { header: 'Longitude', kind: 'general', width: 12 },
        ...fields.map((f) => ({
          header: f.label,
          kind: f.type === 'number' ? ('general' as const) : ('text' as const),
        })),
        { header: 'Ajouté par', kind: 'text', width: 20 },
        { header: 'Ajouté le', kind: 'datetime', width: 17 },
        { header: 'Statut depuis le', kind: 'datetime', width: 17 },
      ],
      rows: rows.map((r): Cell[] => [
        r.name,
        r.category,
        OUTLET_STATUS_LABELS[r.status],
        r.zoneName,
        r.managerName,
        r.phone,
        r.landmark,
        r.lat,
        r.lng,
        ...fields.map((f) => cellOf(r.data[f.key])),
        r.createdByName,
        r.created,
        r.changed,
      ]),
    };
    await this.db.manager.insert(AuditLog, {
      tenantId: user.tenantId,
      userId: user.id,
      action: 'export.outlets',
      method: 'GET',
      path,
      statusCode: 200,
      ip: ip ?? null,
    });
    return this.file(sheet, 'points-de-vente', q.format ?? 'xlsx');
  }

  // ---------------------------------------------------------------- règles

  /** L'agent identifie des points de vente dans ses zones seulement. */
  private async assertPlace(user: AuthUser, lat: number, lng: number) {
    if (user.role !== Role.Agent) return;
    const zones = await this.agentZones(user);
    const [inside] = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM zones
       WHERE id = ANY($1::uuid[]) AND ST_Covers(area, ST_SetSRID(ST_MakePoint($2, $3), 4326))
       LIMIT 1`,
      [zones, lng, lat],
    );
    if (!inside)
      throw conflict(
        'OUTLET_OUTSIDE_ZONES',
        'Ce point de vente est en dehors de vos zones',
      );
  }

  /** Un commerce semblable tout proche : l'agent confirme qu'il s'agit d'un autre. */
  private async assertNoDuplicate(name: string, lat: number, lng: number) {
    const near = await this.db.manager.query<
      { id: string; name: string; status: OutletStatus; distance: number }[]
    >(
      `SELECT o.id, o.name, o.status,
              round(ST_Distance(o.location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography))::int AS distance
       FROM outlets o
       WHERE o.location IS NOT NULL
         AND ST_DWithin(o.location::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
       ORDER BY distance LIMIT 20`,
      [lng, lat, DUPLICATE_SAME_NAME_M],
    );
    const plain = plainName(name);
    const similar = near.filter((o) => {
      const other = plainName(o.name);
      return (
        o.distance <= DUPLICATE_NEAR_M ||
        other === plain ||
        (plain.length >= 4 && other.includes(plain)) ||
        (other.length >= 4 && plain.includes(other))
      );
    });
    if (similar.length)
      throw new BusinessException(
        HttpStatus.CONFLICT,
        'OUTLET_DUPLICATE',
        similar.length > 1
          ? 'Des points de vente semblables existent déjà tout près'
          : `« ${similar[0].name} » existe déjà à ${similar[0].distance} m`,
        { candidates: similar.slice(0, 5) },
      );
  }

  /** Photos prises par l'utilisateur, libres ou déjà sur cette fiche. */
  private async assertPhotos(
    user: AuthUser,
    ids: string[],
    outletId: string | null,
  ) {
    if (!ids.length) return;
    const rows = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM submission_photos
       WHERE id = ANY($1::uuid[]) AND submission_id IS NULL
         AND ((outlet_id IS NULL AND agent_id = $2) OR outlet_id = $3)`,
      [ids, user.id, outletId],
    );
    if (rows.length !== new Set(ids).size)
      throw badRequest(
        'PHOTO_MISSING',
        'Une photo est introuvable : reprenez-la',
      );
  }

  private async attachPhotos(outletId: string, ids: string[]) {
    if (!ids.length) return;
    await this.db.manager.query(
      `UPDATE submission_photos SET outlet_id = $1 WHERE id = ANY($2::uuid[])`,
      [outletId, ids],
    );
  }

  private async history(
    outletId: string,
    from: OutletStatus | null,
    to: OutletStatus,
    comment: string | null,
    userId: string,
  ) {
    await this.db.manager.query(
      `INSERT INTO outlet_status_changes (tenant_id, outlet_id, from_status, to_status, comment, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [this.db.tenantId, outletId, from, to, comment, userId],
    );
  }

  private async agentZones(user: AuthUser): Promise<string[]> {
    const agent = await this.access.getAgent(user.id);
    return this.access.accessibleZoneIds(agent, await this.access.settings());
  }

  private async scope(user: AuthUser): Promise<Scope> {
    if (user.role === Role.Admin) return { zones: null, creators: [] };
    if (user.role === Role.Agent)
      return { zones: await this.agentZones(user), creators: [user.id] };
    if (await this.access.supervisesAll(user))
      return { zones: null, creators: [] };
    // Chef : zones de ses groupes, et fiches créées par lui ou ses agents.
    const groupIds = await this.access.leaderGroupIds(user.id);
    const zones = await this.db.manager.query<{ id: string }[]>(
      `SELECT DISTINCT zone_id AS id FROM group_zones WHERE group_id = ANY($1::uuid[])`,
      [groupIds],
    );
    const agents = (await this.access.agentScope(user)) ?? [];
    return { zones: zones.map((z) => z.id), creators: [user.id, ...agents] };
  }

  /** Condition SQL du périmètre ; un point de vente sans position est visible de tous (à localiser). */
  private scopeSql(scope: Scope, p: (v: unknown) => string) {
    if (!scope.zones) return 'true';
    return `(o.location IS NULL
      OR o.created_by = ANY(${p(scope.creators)}::uuid[])
      OR EXISTS (SELECT 1 FROM zones sz WHERE sz.id = ANY(${p(scope.zones)}::uuid[])
                 AND sz.is_active AND ST_Covers(sz.area, o.location)))`;
  }

  private async file(
    sheet: Sheet,
    base: string,
    format: 'xlsx' | 'csv',
  ): Promise<ExportFile> {
    const [{ name }] = await this.db.manager.query<{ name: string }[]>(
      `SELECT name FROM tenants WHERE id = $1`,
      [this.db.tenantId],
    );
    const filename = `suivi-agent_${base}.${format}`;
    return format === 'csv'
      ? { filename, mime: 'text/csv; charset=utf-8', data: toCsv(sheet) }
      : {
          filename,
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          data: await toXlsx(sheet, `Suivi Agent · ${name}`),
        };
  }
}

function view(r: Row): OutletView {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    managerName: r.managerName,
    phone: r.phone,
    landmark: r.landmark,
    lat: r.lat,
    lng: r.lng,
    accuracy: r.accuracy,
    status: r.status,
    statusChangedAt: r.statusChangedAt,
    photoId: r.photoId,
    data: r.data ?? {},
    zone: r.zoneId ? { id: r.zoneId, name: r.zoneName! } : null,
    createdBy: r.createdById
      ? { id: r.createdById, name: r.createdByName ?? '' }
      : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.distance != null ? { distance: Math.round(Number(r.distance)) } : {}),
  };
}

function cellOf(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non';
  if (typeof v === 'number') return v;
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** Distance approchée en mètres entre deux points proches. */
export function distanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
) {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}
