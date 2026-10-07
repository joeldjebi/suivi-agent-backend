import { Injectable } from '@nestjs/common';
import { FieldType, type MissionField, Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { workedDaysCte } from '../common/worked-days.sql';
import { AuditLog, Mission, MissionType } from '../entities';
import { MissionsService } from '../missions/missions.service';
import type { DaysExportQuery, SubmissionsExportQuery } from './exports.dto';
import { type Cell, type ColumnKind, type Sheet, toCsv, toXlsx } from './sheet';

/** Au-delà, l'export est refusé : il faut réduire la période. */
const MAX_ROWS = 50_000;
const MAX_DAYS = 366;

export interface ExportFile {
  filename: string;
  mime: string;
  data: Buffer;
}

const END_REASON: Record<string, string> = {
  manual: 'Terminée par l’agent',
  auto_reset: 'Fin automatique',
};

/**
 * Exports Excel et CSV des journées de travail et des formulaires de missions (formules qui
 * incluent les exports). Le chef n'exporte que son équipe ; chaque export est journalisé.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly missions: MissionsService,
  ) {}

  async days(user: AuthUser, q: DaysExportQuery, path: string, ip?: string) {
    if (q.to < q.from)
      throw badRequest(
        'INVALID_PERIOD',
        'La fin de la période précède son début',
      );
    const span = (Date.parse(q.to) - Date.parse(q.from)) / 86400_000 + 1;
    if (span > MAX_DAYS)
      throw badRequest('PERIOD_TOO_LONG', 'Exportez au plus un an à la fois');
    const agents = await this.agentFilter(user, q.agentId);
    const settings = await this.access.settings();
    const rows = await this.db.manager.query<Record<string, unknown>[]>(
      `WITH ${workedDaysCte(
        `d.work_date BETWEEN $1::date AND $2::date
         AND ($3::uuid[] IS NULL OR d.agent_id = ANY($3::uuid[]))
         AND ($4::uuid IS NULL OR d.zone_id = $4)`,
      )}
       SELECT to_char(d.work_date, 'YYYY-MM-DD') AS date,
              u.last_name AS "lastName", u.first_name AS "firstName", u.phone,
              g.name AS "group", z.name AS zone,
              to_char(d.started_at AT TIME ZONE $5, 'YYYY-MM-DD HH24:MI') AS start,
              to_char(wd.ended_at AT TIME ZONE $5, 'YYYY-MM-DD HH24:MI') AS "end",
              (SELECT coalesce(sum(extract(epoch FROM coalesce(p.ended_at, now()) - p.started_at)), 0)
                 FROM day_pauses p WHERE p.day_id = d.id) / 60 AS pauses,
              d.worked / 3600 AS worked,
              (SELECT count(*) FROM zone_exits e WHERE e.day_id = d.id)::int AS exits,
              (SELECT coalesce(sum(extract(epoch FROM coalesce(e.ended_at, now()) - e.exited_at)), 0)
                 FROM zone_exits e WHERE e.day_id = d.id) / 60 AS outside,
              wd.status, wd.end_reason AS "endReason"
       FROM days d
       JOIN work_days wd ON wd.id = d.id
       JOIN users u ON u.id = d.agent_id
       LEFT JOIN groups g ON g.id = u.group_id
       LEFT JOIN zones z ON z.id = d.zone_id
       WHERE ($6::uuid IS NULL OR u.group_id = $6)
       ORDER BY d.work_date, u.last_name, u.first_name
       LIMIT ${MAX_ROWS + 1}`,
      [
        q.from,
        q.to,
        agents,
        q.zoneId ?? null,
        settings.timezone,
        q.groupId ?? null,
      ],
    );
    this.assertSize(rows.length);
    const sheet: Sheet = {
      title: 'Journées',
      columns: [
        { header: 'Date', kind: 'date' },
        { header: 'Nom', kind: 'text', width: 18 },
        { header: 'Prénom', kind: 'text', width: 18 },
        { header: 'Téléphone', kind: 'text', width: 18 },
        { header: 'Groupe', kind: 'text', width: 16 },
        { header: 'Zone', kind: 'text', width: 16 },
        { header: 'Début', kind: 'datetime', width: 17 },
        { header: 'Fin', kind: 'datetime', width: 17 },
        { header: 'Pauses (min)', kind: 'number' },
        { header: 'Temps travaillé (h)', kind: 'decimal' },
        { header: 'Sorties de zone', kind: 'number' },
        { header: 'Temps hors zone (min)', kind: 'number' },
        { header: 'Statut', kind: 'text', width: 20 },
      ],
      rows: rows.map((r): Cell[] => [
        r.date as string,
        r.lastName as string,
        r.firstName as string,
        (r.phone as string | null) ?? null,
        (r.group as string | null) ?? null,
        (r.zone as string | null) ?? null,
        r.start as string,
        (r.end as string | null) ?? null,
        Math.round(Number(r.pauses)),
        Math.round(Number(r.worked) * 100) / 100,
        Number(r.exits),
        Math.round(Number(r.outside)),
        r.status === 'ended'
          ? (END_REASON[r.endReason as string] ?? 'Terminée')
          : r.status === 'paused'
            ? 'En pause'
            : 'En cours',
      ]),
    };
    await this.audit(user, 'ExportsController.days', path, ip);
    return this.file(sheet, `journees_${q.from}_${q.to}`, q.format);
  }

  async submissions(
    user: AuthUser,
    q: SubmissionsExportQuery,
    path: string,
    ip?: string,
  ) {
    const m = this.db.manager;
    let typeId = q.typeId;
    let title = '';
    if (q.missionId) {
      // Vérifie que la mission est dans le périmètre de l'utilisateur.
      await this.missions.get(user, q.missionId);
      const mission = await m.findOneByOrFail(Mission, { id: q.missionId });
      typeId = mission.typeId;
      title = mission.title;
    }
    if (!typeId)
      throw badRequest(
        'MISSION_OR_TYPE_REQUIRED',
        'Choisissez une mission ou un type de mission',
      );
    const type = await m.findOneBy(MissionType, { id: typeId });
    if (!type) throw badRequest('UNKNOWN_TYPE', 'Type de mission inconnu');
    const agents = await this.agentFilter(user, q.agentId);
    const settings = await this.access.settings();
    const rows = await m.query<Record<string, unknown>[]>(
      `SELECT s.data, s.status, s.rejected_reason AS "rejectedReason", s.lat, s.lng,
              to_char(s.submitted_at AT TIME ZONE $1, 'YYYY-MM-DD HH24:MI') AS at,
              mi.title AS mission, u.last_name AS "lastName", u.first_name AS "firstName",
              g.name AS "group"
       FROM mission_submissions s
       JOIN missions mi ON mi.id = s.mission_id
       JOIN users u ON u.id = s.agent_id
       LEFT JOIN groups g ON g.id = u.group_id
       WHERE mi.type_id = $2
         AND ($3::uuid IS NULL OR s.mission_id = $3)
         AND ($4::date IS NULL OR (s.submitted_at AT TIME ZONE $1)::date >= $4)
         AND ($5::date IS NULL OR (s.submitted_at AT TIME ZONE $1)::date <= $5)
         AND ($6::text IS NULL OR s.status = $6)
         AND ($7::uuid[] IS NULL OR s.agent_id = ANY($7::uuid[]))
       ORDER BY s.submitted_at
       LIMIT ${MAX_ROWS + 1}`,
      [
        settings.timezone,
        typeId,
        q.missionId ?? null,
        q.from ?? null,
        q.to ?? null,
        q.status ?? null,
        agents,
      ],
    );
    this.assertSize(rows.length);
    // Photos : heure de prise et position (l'image se consulte sur la plateforme).
    const photoIds = rows.flatMap((r) =>
      type.fields
        .filter((f) => f.type === FieldType.Photo)
        .map((f) => (r.data as Record<string, unknown> | null)?.[f.key])
        .filter((v): v is string => typeof v === 'string'),
    );
    const photos = new Map(
      (photoIds.length
        ? await m.query<
            { id: string; at: string; lat: number | null; lng: number | null }[]
          >(
            `SELECT id, to_char(taken_at AT TIME ZONE $2, 'DD/MM/YYYY HH24:MI') AS at, lat, lng
             FROM submission_photos WHERE id = ANY($1::uuid[])`,
            [photoIds, settings.timezone],
          )
        : []
      ).map((p) => [p.id, p]),
    );
    const kind = (f: MissionField): ColumnKind =>
      f.type === FieldType.Number
        ? 'general'
        : f.type === FieldType.Date
          ? 'date'
          : 'text';
    const value = (f: MissionField, v: unknown): Cell => {
      if (v === undefined || v === null || v === '') return null;
      if (f.type === FieldType.Boolean) return v ? 'Oui' : 'Non';
      if (f.type === FieldType.Photo) {
        const p = typeof v === 'string' ? photos.get(v) : undefined;
        if (!p) return 'Photo';
        const where =
          p.lat != null && p.lng != null
            ? ` · ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`
            : '';
        return `Photo du ${p.at}${where}`;
      }
      const raw =
        typeof v === 'string' || typeof v === 'number'
          ? String(v)
          : JSON.stringify(v);
      if (f.type === FieldType.Number) {
        const n = Number(raw);
        return Number.isFinite(n) ? n : raw;
      }
      if (f.type === FieldType.Date) return raw.slice(0, 10);
      return raw;
    };
    const sheet: Sheet = {
      title: 'Formulaires',
      columns: [
        { header: 'N°', kind: 'number', width: 7 },
        { header: 'Date et heure', kind: 'datetime', width: 17 },
        { header: 'Mission', kind: 'text', width: 28 },
        { header: 'Nom', kind: 'text', width: 18 },
        { header: 'Prénom', kind: 'text', width: 18 },
        { header: 'Groupe', kind: 'text', width: 16 },
        ...type.fields.map((f) => ({
          header: f.label,
          kind: kind(f),
          width: Math.min(40, Math.max(14, f.label.length + 2)),
        })),
        { header: 'Statut', kind: 'text', width: 12 },
        { header: 'Motif du rejet', kind: 'text', width: 30 },
        { header: 'Latitude', kind: 'general', width: 12 },
        { header: 'Longitude', kind: 'general', width: 12 },
      ],
      rows: rows.map((r, i): Cell[] => {
        const data = (r.data ?? {}) as Record<string, unknown>;
        return [
          i + 1,
          r.at as string,
          r.mission as string,
          r.lastName as string,
          r.firstName as string,
          (r.group as string | null) ?? null,
          ...type.fields.map((f) => value(f, data[f.key])),
          r.status === 'rejected' ? 'Rejeté' : 'Accepté',
          (r.rejectedReason as string | null) ?? null,
          r.lat === null ? null : Number(r.lat),
          r.lng === null ? null : Number(r.lng),
        ];
      }),
    };
    await this.audit(user, 'ExportsController.submissions', path, ip);
    const name = slug(title || type.name);
    return this.file(
      sheet,
      `formulaires_${name}${q.from ? `_${q.from}` : ''}${q.to ? `_${q.to}` : ''}`,
      q.format,
    );
  }

  /** Agents exportables : tous pour l'administrateur, l'équipe pour le chef. */
  private async agentFilter(
    user: AuthUser,
    agentId?: string,
  ): Promise<string[] | null> {
    const scope =
      user.role === Role.Admin ? null : await this.access.agentScope(user);
    if (agentId) return scope && !scope.includes(agentId) ? [] : [agentId];
    return scope;
  }

  private assertSize(n: number) {
    if (n > MAX_ROWS)
      throw badRequest(
        'EXPORT_TOO_LARGE',
        `Plus de ${MAX_ROWS.toLocaleString('fr-FR')} lignes : réduisez la période ou filtrez`,
      );
  }

  private async file(
    sheet: Sheet,
    base: string,
    format: 'xlsx' | 'csv' = 'xlsx',
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

  /** Les exports contiennent des données personnelles : chacun est tracé (journal d'accès). */
  private async audit(
    user: AuthUser,
    action: string,
    path: string,
    ip?: string,
  ) {
    await this.db.manager.insert(AuditLog, {
      tenantId: user.tenantId,
      userId: user.id,
      action,
      method: 'GET',
      path,
      statusCode: 200,
      ip: ip ?? null,
    });
  }
}

/** Nom de fichier lisible : minuscules, sans accents ni espaces. */
function slug(text: string) {
  return (
    text
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'export'
  );
}
