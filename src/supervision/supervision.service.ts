import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppService, type Sante } from '../app.service';
import { DbService } from '../common/db.service';
import { RedisService } from '../common/redis.service';
import { ErrorLogService } from '../error-log/error-log.service';

/** Durée de conservation des chiffres lus chez les outils externes. */
const CACHE_SECONDES = 120;
/** Délai maximal accordé à chaque outil externe. */
const DELAI_MS = 8000;

/** Bloc d'un outil : non configuré, en erreur (message court), ou ses chiffres. */
export type Bloc<T> =
  | { configured: false }
  | { configured: true; error: string }
  | ({ configured: true; error?: undefined } & T);

export interface Sonde {
  name: string;
  url: string;
  status: 'up' | 'down' | 'paused' | 'pending';
  uptime: { day: number | null; week: number | null; month: number | null };
  responseMs: number | null;
  /** Dernières coupures (plus récente d'abord). */
  incidents: { at: string; durationS: number }[];
  /** Temps de réponse moyen par heure, dernières 24 h (plus ancien d'abord). */
  history: { at: string; ms: number }[];
}

export interface Disponibilite {
  monitors: Sonde[];
}

export interface Erreurs {
  url: string | null;
  unresolved: number;
  projects: { slug: string; name: string; unresolved: number }[];
  /** Erreurs reçues par jour sur 7 jours, tous projets confondus. */
  perDay: { date: string; count: number }[];
  top: {
    title: string;
    project: string;
    count: number;
    users: number;
    lastSeen: string;
    level: string;
    link: string;
  }[];
}

export interface Serveur {
  cpu: number | null;
  ram: { usedPct: number; totalMb: number } | null;
  disk: { usedPct: number; totalGb: number; availGb: number } | null;
  load: { one: number; five: number; fifteen: number } | null;
  uptimeS: number | null;
  /** Nombre de cœurs : la charge se lit par rapport à lui. */
  cores: number | null;
  /** Processeur et mémoire (%), par demi-heure sur 24 h (plus ancien d'abord). */
  history: { at: string; cpu: number; ram: number | null }[];
}

export interface Interne {
  health: Sante;
  apiUptimeS: number;
  apiMemoryMb: number;
  databaseMb: number | null;
  databaseConnections: number | null;
  redisMemoryMb: number | null;
  activeDays: number | null;
  positionsLastHour: number | null;
  errorLog: { open: number; lastDay: number };
  /** Positions reçues et agents qui en ont envoyé, heure par heure sur 24 h. */
  activity: { at: string; positions: number; agents: number }[] | null;
}

export interface Supervision {
  generatedAt: string;
  performx: Interne;
  availability: Bloc<Disponibilite>;
  errors: Bloc<Erreurs>;
  server: Bloc<Serveur>;
}

/** Arrondi à une décimale (pourcentages, mégaoctets). */
const r1 = (n: number) => Math.round(n * 10) / 10;
const nombre = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * Synthèse de la page « Supervision » de la console éditeur : état interne de PerformX,
 * disponibilité (UptimeRobot), erreurs (Sentry) et serveur (Netdata). Chaque outil
 * externe est facultatif (variable d'environnement vide = bloc non configuré) et lu en
 * lecture seule ; une panne de l'un n'empêche pas l'affichage des autres.
 */
@Injectable()
export class SupervisionService {
  private readonly logger = new Logger(SupervisionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly app: AppService,
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly errorLog: ErrorLogService,
  ) {}

  async overview(refresh = false): Promise<Supervision> {
    const [performx, availability, errors, server] = await Promise.all([
      this.interne(),
      this.enCache('uptimerobot', refresh, () => this.uptimeRobot()),
      this.enCache('sentry', refresh, () => this.sentry()),
      this.enCache('netdata', refresh, () => this.netdata()),
    ]);
    return {
      generatedAt: new Date().toISOString(),
      performx,
      availability,
      errors,
      server,
    };
  }

  // PerformX (toujours lu en direct : requêtes légères)

  private async interne(): Promise<Interne> {
    const m = this.db.manager;
    const tolerant = <T>(p: Promise<T>) => p.catch(() => null);
    const [health, base, redisInfo, activite, errorLog, parHeure] =
      await Promise.all([
        this.app.health(),
        tolerant(
          this.db.runAsSystem(() =>
            m.query<{ size: string; connections: number }[]>(
              `SELECT pg_database_size(current_database())::bigint AS size,
                    (SELECT count(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections`,
            ),
          ),
        ),
        tolerant(this.redis.client.info('memory')),
        tolerant(
          this.db.runAsSystem(() =>
            m.query<{ active: number; positions: number }[]>(
              `SELECT
               (SELECT count(*)::int FROM work_days
                 WHERE status IN ('active', 'paused') AND work_date >= current_date - 1) AS active,
               (SELECT count(*)::int FROM positions p JOIN work_days d ON d.id = p.day_id
                 WHERE d.work_date >= current_date - 1
                   AND p.recorded_at > now() - interval '1 hour') AS positions`,
            ),
          ),
        ),
        this.errorLog.summary(),
        tolerant(
          this.db.runAsSystem(() =>
            m.query<{ h: string; positions: number; agents: number }[]>(
              `SELECT extract(epoch FROM date_trunc('hour', p.recorded_at))::bigint AS h,
                    count(*)::int AS positions,
                    count(DISTINCT d.agent_id)::int AS agents
             FROM positions p JOIN work_days d ON d.id = p.day_id
             WHERE d.work_date >= current_date - 2
               AND p.recorded_at > now() - interval '24 hours'
             GROUP BY 1`,
            ),
          ),
        ),
      ]);
    // Les 24 dernières heures, y compris celles sans position (à zéro).
    const heureEnCours = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const activity = parHeure
      ? Array.from({ length: 24 }, (_, i) => {
          const debut = heureEnCours - (23 - i) * 3_600_000;
          const ligne = parHeure.find((r) => Number(r.h) * 1000 === debut);
          return {
            at: new Date(debut).toISOString(),
            positions: ligne?.positions ?? 0,
            agents: ligne?.agents ?? 0,
          };
        })
      : null;
    const redisOctets = redisInfo
      ? nombre(/used_memory:(\d+)/.exec(redisInfo)?.[1])
      : null;
    return {
      health,
      apiUptimeS: Math.round(process.uptime()),
      apiMemoryMb: r1(process.memoryUsage().rss / 1048576),
      databaseMb: base ? r1(Number(base[0].size) / 1048576) : null,
      databaseConnections: base ? base[0].connections : null,
      redisMemoryMb: redisOctets === null ? null : r1(redisOctets / 1048576),
      activeDays: activite ? activite[0].active : null,
      positionsLastHour: activite ? activite[0].positions : null,
      errorLog,
      activity,
    };
  }

  // Cache Redis commun aux outils externes

  private async enCache<T>(
    nom: string,
    refresh: boolean,
    lire: () => Promise<Bloc<T>>,
  ): Promise<Bloc<T>> {
    const cle = `supervision:${nom}`;
    if (!refresh) {
      const brut = await this.redis.client.get(cle).catch(() => null);
      if (brut) return JSON.parse(brut) as Bloc<T>;
    }
    let bloc: Bloc<T>;
    try {
      bloc = await lire();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`Supervision ${nom} : ${message}`);
      bloc = { configured: true, error: message.slice(0, 200) };
    }
    // Une erreur est gardée moins longtemps, pour réessayer vite.
    if (bloc.configured) {
      await this.redis.client
        .set(cle, JSON.stringify(bloc), 'EX', bloc.error ? 30 : CACHE_SECONDES)
        .catch(() => undefined);
    }
    return bloc;
  }

  private async appel<T>(url: string, init: RequestInit = {}) {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DELAI_MS),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401 || res.status === 403
          ? `accès refusé (HTTP ${res.status}) : vérifiez la clé`
          : `HTTP ${res.status}`,
      );
    }
    return { body: (await res.json()) as T, headers: res.headers };
  }

  // Disponibilité : UptimeRobot (clé API en lecture seule)

  private async uptimeRobot(): Promise<Bloc<Disponibilite>> {
    const cle = this.config.get<string>('UPTIMEROBOT_API_KEY');
    if (!cle) return { configured: false };
    const { body } = await this.appel<{
      stat: string;
      error?: { message?: string };
      monitors?: {
        friendly_name: string;
        url: string;
        status: number;
        custom_uptime_ratio?: string;
        average_response_time?: string;
        logs?: { type: number; datetime: number; duration: number }[];
        response_times?: { datetime: number; value: number }[];
      }[];
    }>('https://api.uptimerobot.com/v2/getMonitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        api_key: cle,
        format: 'json',
        custom_uptime_ratios: '1-7-30',
        // Temps de réponse : moyenne par heure sur 24 h (et average_response_time).
        response_times: '1',
        response_times_start_date: String(
          Math.floor(Date.now() / 1000) - 86_400,
        ),
        response_times_end_date: String(Math.floor(Date.now() / 1000)),
        response_times_average: '60',
        response_times_limit: '100',
        logs: '1',
        logs_limit: '10',
      }),
    });
    if (body.stat !== 'ok') {
      throw new Error(body.error?.message ?? 'réponse UptimeRobot invalide');
    }
    const etat = (s: number): Sonde['status'] =>
      s === 2 ? 'up' : s === 0 ? 'paused' : s === 1 ? 'pending' : 'down';
    return {
      configured: true,
      monitors: (body.monitors ?? []).map((m) => {
        const [day, week, month] = (m.custom_uptime_ratio ?? '')
          .split('-')
          .map(nombre);
        const temps = nombre(m.average_response_time);
        return {
          name: m.friendly_name,
          url: m.url,
          status: etat(m.status),
          uptime: {
            day: day ?? null,
            week: week ?? null,
            month: month ?? null,
          },
          responseMs: temps === null ? null : Math.round(temps),
          // Type 1 = coupure (2 = retour, 98 = démarrage, 99 = pause).
          incidents: (m.logs ?? [])
            .filter((l) => l.type === 1)
            .slice(0, 5)
            .map((l) => ({
              at: new Date(l.datetime * 1000).toISOString(),
              durationS: l.duration,
            })),
          history: (m.response_times ?? [])
            .filter((t) => Number.isFinite(t.value))
            .sort((a, b) => a.datetime - b.datetime)
            .map((t) => ({
              at: new Date(t.datetime * 1000).toISOString(),
              ms: Math.round(t.value),
            })),
        };
      }),
    };
  }

  // Erreurs : Sentry (jeton en lecture seule : org:read, project:read, event:read)

  private async sentry(): Promise<Bloc<Erreurs>> {
    const jeton = this.config.get<string>('SENTRY_AUTH_TOKEN');
    const org = this.config.get<string>('SENTRY_ORG');
    if (!jeton || !org) return { configured: false };
    const base = (
      this.config.get<string>('SENTRY_API_URL') || 'https://de.sentry.io'
    ).replace(/\/$/, '');
    const init = { headers: { Authorization: `Bearer ${jeton}` } };
    const racine = `${base}/api/0/organizations/${encodeURIComponent(org)}`;

    const [projets, problemes, stats] = await Promise.all([
      this.appel<{ slug: string; name: string }[]>(`${racine}/projects/`, init),
      this.appel<
        {
          title: string;
          count: string;
          userCount: number;
          lastSeen: string;
          level: string;
          permalink: string;
          project: { slug: string };
        }[]
      >(
        `${racine}/issues/?query=is:unresolved&statsPeriod=14d&sort=freq&limit=100`,
        init,
      ),
      // Facultatif : sans ces chiffres, le reste s'affiche quand même.
      this.appel<{
        intervals: string[];
        groups: {
          totals: Record<string, number>;
          series: Record<string, number[]>;
        }[];
      }>(
        `${racine}/stats_v2/?field=sum(quantity)&category=error&outcome=accepted&interval=1d&statsPeriod=7d`,
        init,
      ).catch(() => null),
    ]);

    const parProjet = new Map<string, number>();
    for (const p of problemes.body) {
      parProjet.set(p.project.slug, (parProjet.get(p.project.slug) ?? 0) + 1);
    }
    const total = nombre(problemes.headers.get('X-Hits'));
    const serie = stats?.body.groups[0]?.series['sum(quantity)'] ?? [];
    return {
      configured: true,
      url:
        this.config.get<string>('SENTRY_ISSUES_URL') ||
        `https://${encodeURIComponent(org)}.sentry.io/issues/`,
      unresolved: total ?? problemes.body.length,
      projects: projets.body.map((p) => ({
        slug: p.slug,
        name: p.name,
        unresolved: parProjet.get(p.slug) ?? 0,
      })),
      perDay: (stats?.body.intervals ?? []).map((d, i) => ({
        date: d.slice(0, 10),
        count: serie[i] ?? 0,
      })),
      top: problemes.body.slice(0, 8).map((p) => ({
        title: p.title,
        project: p.project.slug,
        count: Number(p.count) || 0,
        users: p.userCount,
        lastSeen: p.lastSeen,
        level: p.level,
        link: p.permalink,
      })),
    };
  }

  // Serveur : agent Netdata local (jamais ouvert à Internet)

  private async netdata(): Promise<Bloc<Serveur>> {
    const url = this.config.get<string>('NETDATA_URL');
    if (!url) return { configured: false };
    const base = url.replace(/\/$/, '');
    /** Moyenne de la dernière minute d'un graphique Netdata, par dimension. */
    const graphique = async (chart: string) => {
      const { body } = await this.appel<{
        labels: string[];
        data: number[][];
      }>(
        `${base}/api/v1/data?chart=${encodeURIComponent(chart)}&after=-60&points=1&group=average&format=json&options=absolute`,
      );
      const ligne = body.data[0] ?? [];
      const valeurs: Record<string, number> = {};
      body.labels.forEach((l, i) => {
        if (i > 0) valeurs[l] = Number(ligne[i]) || 0;
      });
      return valeurs;
    };
    /** Un graphique Netdata sur 24 h, par demi-heure : [horodatage, dimensions…]. */
    const historique = async (chart: string) => {
      const { body } = await this.appel<{
        labels: string[];
        data: number[][];
      }>(
        `${base}/api/v1/data?chart=${encodeURIComponent(chart)}&after=-86400&points=48&group=average&format=json&options=absolute`,
      );
      return body.data
        .map((ligne) => ({
          t: Number(ligne[0]),
          valeurs: Object.fromEntries(
            body.labels.slice(1).map((l, i) => [l, Number(ligne[i + 1]) || 0]),
          ),
        }))
        .sort((a, b) => a.t - b.t);
    };
    const tolerant = <T>(p: Promise<T>) => p.catch(() => null);
    const somme = (v: Record<string, number>) =>
      Object.values(v).reduce((a, b) => a + b, 0);

    // Le processeur sert de test de connexion : s'il échoue, le bloc est en erreur.
    const cpu = await graphique('system.cpu');
    const [ram, disque, charge, uptime, info, cpuJour, ramJour] =
      await Promise.all([
        tolerant(graphique('system.ram')),
        tolerant(graphique('disk_space./')),
        tolerant(graphique('system.load')),
        tolerant(graphique('system.uptime')),
        tolerant(
          this.appel<{ cores_total?: string | number }>(`${base}/api/v1/info`),
        ),
        tolerant(historique('system.cpu')),
        tolerant(historique('system.ram')),
      ]);
    const ramPct = (v: Record<string, number>) => {
      const total = somme(v);
      return total > 0 ? r1(((v.used ?? 0) / total) * 100) : null;
    };
    const ramTotal = ram ? somme(ram) : 0;
    const disqueTotal = disque ? somme(disque) : 0;
    return {
      configured: true,
      cpu: r1(somme(cpu)),
      ram:
        ram && ramTotal > 0
          ? {
              usedPct: r1(((ram.used ?? 0) / ramTotal) * 100),
              totalMb: Math.round(ramTotal),
            }
          : null,
      disk:
        disque && disqueTotal > 0
          ? {
              usedPct: r1(
                (((disque.used ?? 0) + (disque['reserved for root'] ?? 0)) /
                  disqueTotal) *
                  100,
              ),
              totalGb: r1(disqueTotal),
              availGb: r1(disque.avail ?? 0),
            }
          : null,
      load: charge
        ? {
            one: r1(charge.load1 ?? 0),
            five: r1(charge.load5 ?? 0),
            fifteen: r1(charge.load15 ?? 0),
          }
        : null,
      uptimeS: uptime ? Math.round(uptime.uptime ?? 0) || null : null,
      cores: nombre(info?.body.cores_total),
      history: (cpuJour ?? []).map((p) => {
        const r = ramJour?.find((x) => x.t === p.t);
        return {
          at: new Date(p.t * 1000).toISOString(),
          cpu: r1(somme(p.valeurs)),
          ram: r ? ramPct(r.valeurs) : null,
        };
      }),
    };
  }
}
