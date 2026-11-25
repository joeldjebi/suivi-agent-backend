import { Injectable } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { IpIntelService } from '../common/ip-intel.service';

export interface RecordViewInput {
  viewId: string;
  prospectId?: string | null;
  seconds?: number;
  percent?: number;
  duration?: number | null;
  orientation?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  referer?: string | null;
}

interface ViewRow {
  id: string;
  prospect_id: string | null;
  prospect_nom: string | null;
  seconds: number;
  percent: number;
  duration: number | null;
  orientation: string | null;
  ip: string | null;
  user_agent: string | null;
  referer: string | null;
  retour: boolean;
  created_at: Date;
}

/** Suivi des lectures de la vidéo de présentation. Table de plateforme : on lit/écrit hors RLS. */
@Injectable()
export class VideoService {
  constructor(
    private readonly db: DbService,
    private readonly ipIntel: IpIntelService,
  ) {}

  /** Enregistre ou met à jour un visionnage (on garde le temps et le % les plus élevés). */
  async record(input: RecordViewInput): Promise<void> {
    await this.db.runAsSystem(() =>
      this.db.manager.query(
        `INSERT INTO video_views
           (view_id, prospect_id, seconds, percent, duration, orientation, ip, user_agent, referer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (view_id) DO UPDATE SET
           seconds = GREATEST(video_views.seconds, EXCLUDED.seconds),
           percent = GREATEST(video_views.percent, EXCLUDED.percent),
           duration = COALESCE(EXCLUDED.duration, video_views.duration),
           prospect_id = COALESCE(video_views.prospect_id, EXCLUDED.prospect_id),
           orientation = COALESCE(EXCLUDED.orientation, video_views.orientation),
           updated_at = now()`,
        [
          input.viewId,
          input.prospectId ?? null,
          Math.round(input.seconds ?? 0),
          Math.round(input.percent ?? 0),
          input.duration ?? null,
          input.orientation ?? null,
          input.ip ?? null,
          input.userAgent?.slice(0, 500) ?? null,
          input.referer?.slice(0, 500) ?? null,
        ],
      ),
    );
  }

  /** Liste des visionnages, les plus récents d'abord, enrichis de la géolocalisation d'IP. */
  async list(query: { page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 30));
    const { rows, total } = await this.db.runAsSystem(async () => {
      const [{ total }] = await this.db.manager.query<{ total: string }[]>(
        `SELECT count(*)::int AS total FROM video_views`,
      );
      const rows = await this.db.manager.query<ViewRow[]>(
        `SELECT v.id, v.prospect_id, v.seconds, v.percent, v.duration, v.orientation,
                v.ip, v.user_agent, v.referer, v.created_at, p.entreprise AS prospect_nom,
                EXISTS (
                  SELECT 1 FROM video_views v2
                   WHERE coalesce(v2.ip,'') = coalesce(v.ip,'')
                     AND coalesce(v2.user_agent,'') = coalesce(v.user_agent,'')
                     AND v2.created_at < v.created_at
                ) AS retour
           FROM video_views v
           LEFT JOIN prospects p ON p.id = v.prospect_id
          ORDER BY v.created_at DESC
          LIMIT $1 OFFSET $2`,
        [limit, (page - 1) * limit],
      );
      return { rows, total: Number(total) };
    });
    const intel = await this.ipIntel.lookupMany(
      rows.map((r) => r.ip).filter((ip): ip is string => !!ip),
    );
    return {
      items: rows.map((r) => {
        const geo = r.ip ? (intel.get(r.ip) ?? null) : null;
        return {
          id: r.id,
          prospectNom: r.prospect_nom,
          seconds: r.seconds,
          percent: r.percent,
          duration: r.duration,
          orientation: r.orientation,
          userAgent: r.user_agent,
          referer: r.referer,
          retour: r.retour === true,
          createdAt: r.created_at,
          pays: geo?.country ?? null,
          ville: geo?.city ?? null,
        };
      }),
      total,
      page,
      limit,
    };
  }

  /** Chiffres clés : nombre de visites, visiteurs différents, temps moyen (parmi les lancées). */
  async summary() {
    return this.db.runAsSystem(async () => {
      const [agg] = await this.db.manager.query<
        {
          vues: string;
          vues_7j: string;
          visiteurs: string;
          temps_moyen: string | null;
        }[]
      >(`
        SELECT
          count(*)::int AS vues,
          count(*) FILTER (WHERE created_at >= now() - interval '7 days')::int AS vues_7j,
          count(DISTINCT coalesce(ip, '') || '|' || coalesce(user_agent, ''))::int AS visiteurs,
          round(avg(seconds) FILTER (WHERE seconds > 0))::int AS temps_moyen
        FROM video_views`);
      return {
        vues: Number(agg?.vues ?? 0),
        vues7j: Number(agg?.vues_7j ?? 0),
        visiteurs: Number(agg?.visiteurs ?? 0),
        tempsMoyen: Number(agg?.temps_moyen ?? 0),
      };
    });
  }
}
