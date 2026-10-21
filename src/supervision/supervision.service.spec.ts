import type { ConfigService } from '@nestjs/config';
import type { AppService } from '../app.service';
import type { DbService } from '../common/db.service';
import type { RedisService } from '../common/redis.service';
import type { ErrorLogService } from '../error-log/error-log.service';
import { SupervisionService } from './supervision.service';

/** Réponse JSON factice de fetch. */
const json = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

describe('SupervisionService', () => {
  let env: Record<string, string>;
  let cache: Map<string, string>;
  let fetchMock: jest.SpyInstance;

  const service = () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('pg_database_size')
          ? [{ size: '52428800', connections: 7 }]
          : [{ active: 3, positions: 360 }],
      ),
    );
    return new SupervisionService(
      { get: (k: string) => env[k] } as unknown as ConfigService,
      {
        health: () =>
          Promise.resolve({
            status: 'ok',
            database: 'up',
            postgis: '3.4',
            redis: 'up',
          }),
      } as unknown as AppService,
      {
        manager: { query },
        runAsSystem: <T>(fn: () => Promise<T>) => fn(),
      } as unknown as DbService,
      {
        client: {
          info: () => Promise.resolve('# Memory\r\nused_memory:2097152\r\n'),
          get: (k: string) => Promise.resolve(cache.get(k) ?? null),
          set: (k: string, v: string) => {
            cache.set(k, v);
            return Promise.resolve('OK');
          },
        },
      } as unknown as RedisService,
      {
        summary: () => Promise.resolve({ open: 2, lastDay: 1 }),
      } as unknown as ErrorLogService,
    );
  };

  beforeEach(() => {
    env = {};
    cache = new Map();
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('sans clé : outils non configurés, état interne seul', async () => {
    const s = await service().overview();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(s.availability).toEqual({ configured: false });
    expect(s.errors).toEqual({ configured: false });
    expect(s.server).toEqual({ configured: false });
    expect(s.performx).toMatchObject({
      health: { status: 'ok' },
      databaseMb: 50,
      databaseConnections: 7,
      redisMemoryMb: 2,
      activeDays: 3,
      positionsLastHour: 360,
      errorLog: { open: 2, lastDay: 1 },
    });
  });

  it('UptimeRobot : sondes, taux de disponibilité et coupures, puis cache', async () => {
    env.UPTIMEROBOT_API_KEY = 'ur-lecture';
    fetchMock.mockResolvedValue(
      json({
        stat: 'ok',
        monitors: [
          {
            friendly_name: 'API',
            url: 'https://performx.online/api/health',
            status: 2,
            custom_uptime_ratio: '100.000-99.950-99.900',
            average_response_time: '231.6',
            logs: [
              { type: 2, datetime: 1760000400, duration: 0 },
              { type: 1, datetime: 1760000000, duration: 300 },
            ],
          },
          { friendly_name: 'Site', url: 'https://performx.online', status: 9 },
        ],
      }),
    );
    const s = await service().overview();
    expect(s.availability).toEqual({
      configured: true,
      monitors: [
        {
          name: 'API',
          url: 'https://performx.online/api/health',
          status: 'up',
          uptime: { day: 100, week: 99.95, month: 99.9 },
          responseMs: 232,
          incidents: [
            { at: new Date(1760000000000).toISOString(), durationS: 300 },
          ],
        },
        {
          name: 'Site',
          url: 'https://performx.online',
          status: 'down',
          uptime: { day: null, week: null, month: null },
          responseMs: null,
          incidents: [],
        },
      ],
    });
    const corps = (fetchMock.mock.calls[0][1] as { body: URLSearchParams })
      .body;
    expect(corps.get('api_key')).toBe('ur-lecture');

    // Deuxième lecture : servie par le cache ; refresh relit l'outil.
    await service().overview();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service().overview(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clé refusée : le bloc signale l’erreur sans bloquer les autres', async () => {
    env.UPTIMEROBOT_API_KEY = 'mauvaise';
    env.NETDATA_URL = 'http://host.docker.internal:19999';
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url.includes('uptimerobot')
          ? json({ stat: 'fail', error: { message: 'api_key not found.' } })
          : json({
              labels: ['time', 'user', 'system'],
              data: [[1, 12.5, 4.25]],
            }),
      ),
    );
    const s = await service().overview();
    expect(s.availability).toEqual({
      configured: true,
      error: 'api_key not found.',
    });
    expect(s.server).toMatchObject({ configured: true, cpu: 16.8 });
  });

  it('Sentry : erreurs non résolues par projet, par jour et les plus fréquentes', async () => {
    env.SENTRY_AUTH_TOKEN = 'sntrys_lecture';
    env.SENTRY_ORG = 'performx-sl';
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/projects/'))
        return Promise.resolve(
          json([
            { slug: 'api', name: 'api' },
            { slug: 'web', name: 'web' },
          ]),
        );
      if (url.includes('/issues/'))
        return Promise.resolve(
          json(
            [
              {
                title: 'TypeError: x is undefined',
                count: '42',
                userCount: 3,
                lastSeen: '2026-10-21T10:00:00Z',
                level: 'error',
                permalink: 'https://performx-sl.sentry.io/issues/1/',
                project: { slug: 'web' },
              },
            ],
            200,
            { 'X-Hits': '1' },
          ),
        );
      return Promise.resolve(
        json({
          intervals: ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'],
          groups: [{ totals: {}, series: { 'sum(quantity)': [5, 42] } }],
        }),
      );
    });
    const s = await service().overview();
    expect(fetchMock.mock.calls[0][0]).toMatch(
      /^https:\/\/de\.sentry\.io\/api\/0\/organizations\/performx-sl\//,
    );
    expect(
      (fetchMock.mock.calls[0][1] as { headers: Record<string, string> })
        .headers.Authorization,
    ).toBe('Bearer sntrys_lecture');
    expect(s.errors).toMatchObject({
      configured: true,
      url: 'https://performx-sl.sentry.io/issues/',
      unresolved: 1,
      projects: [
        { slug: 'api', unresolved: 0 },
        { slug: 'web', unresolved: 1 },
      ],
      perDay: [
        { date: '2026-10-20', count: 5 },
        { date: '2026-10-21', count: 42 },
      ],
      top: [{ title: 'TypeError: x is undefined', count: 42, users: 3 }],
    });
  });

  it('Netdata : processeur, mémoire, disque, charge et durée de fonctionnement', async () => {
    env.NETDATA_URL = 'http://host.docker.internal:19999/';
    const graphiques: Record<string, { labels: string[]; data: number[][] }> = {
      'system.cpu': {
        labels: ['time', 'user', 'system', 'iowait'],
        data: [[1, 20, 5, 1]],
      },
      'system.ram': {
        labels: ['time', 'free', 'used', 'cached', 'buffers'],
        data: [[1, 2000, 4000, 1800, 200]],
      },
      'disk_space./': {
        labels: ['time', 'avail', 'used', 'reserved for root'],
        data: [[1, 60, 35, 5]],
      },
      'system.load': {
        labels: ['time', 'load1', 'load5', 'load15'],
        data: [[1, 0.52, 0.4, 0.33]],
      },
      'system.uptime': { labels: ['time', 'uptime'], data: [[1, 864000]] },
    };
    fetchMock.mockImplementation((url: string) => {
      const chart = decodeURIComponent(/chart=([^&]+)/.exec(url)![1]);
      expect(
        url.startsWith('http://host.docker.internal:19999/api/v1/data'),
      ).toBe(true);
      return Promise.resolve(json(graphiques[chart]));
    });
    const s = await service().overview();
    expect(s.server).toEqual({
      configured: true,
      cpu: 26,
      ram: { usedPct: 50, totalMb: 8000 },
      disk: { usedPct: 40, totalGb: 100, availGb: 60 },
      load: { one: 0.5, five: 0.4, fifteen: 0.3 },
      uptimeS: 864000,
    });
  });

  it('Netdata injoignable : bloc en erreur, gardé peu de temps', async () => {
    env.NETDATA_URL = 'http://host.docker.internal:19999';
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    const s = await service().overview();
    expect(s.server).toEqual({ configured: true, error: 'fetch failed' });
  });
});
