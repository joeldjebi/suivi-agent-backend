import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import 'dotenv/config';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/redis.service';

export const PASSWORD = 'Password123!';

export async function createApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(0);
  return app;
}

/** Connexion « propriétaire » pour préparer et vérifier les données hors API. */
export async function ownerDataSource(): Promise<DataSource> {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
  });
  return ds.initialize();
}

export async function resetDatabase(app: INestApplication, owner: DataSource) {
  await owner.query(`TRUNCATE tenants, audit_logs CASCADE`);
  await owner.query(`TRUNCATE demo_requests, landing_assets, doc_articles`);
  await owner.query(
    `UPDATE landing_pages SET draft = NULL, published = NULL, published_at = NULL`,
  );
  // Catalogue d'origine : un test interrompu ne doit pas fausser les suivants.
  await owner.query(`
    UPDATE platform_settings SET trial_plan_code = 'enterprise', default_plan_code = 'advanced',
      trial_days = 14, annual_discount_percent = 15, invoice_due_days = 15, suspend_after_days = 15`);
  await owner.query(
    `DELETE FROM plans WHERE code NOT IN ('base', 'advanced', 'enterprise')`,
  );
  await owner.query(`
    UPDATE plans SET is_active = true, monthly_price = v.price, included_agents = v.agents,
                     included_leads = v.leads, extra_agent_price = v.extra, features = v.features
    FROM (VALUES
      ('base', 5000, 10, 1, 500, ARRAY[]::text[]),
      ('advanced', 15000, 30, 3, 450, ARRAY['groups', 'manual_approval', 'missions', 'branding', 'exports']),
      ('enterprise', 40000, 100, 10, 400, ARRAY['groups', 'manual_approval', 'missions', 'branding', 'exports',
                                                'stats', 'team_leads', 'audit', 'payroll'])
    ) AS v(code, price, agents, leads, extra, features)
    WHERE plans.code = v.code`);
  const redis = app.get(RedisService).client;
  const keys = [
    ...(await redis.keys('live:*')),
    ...(await redis.keys('platform:fail:*')),
    ...(await redis.keys('demo:ip:*')),
  ];
  if (keys.length) await redis.del(...keys);
}

let counter = 0;
/** Numéro unique, au format saisi par un utilisateur (avec espaces). */
export const uniquePhone = () => {
  const n =
    String(Date.now() % 1e6).padStart(6, '0') +
    String(++counter % 100).padStart(2, '0');
  return `07 ${n.slice(0, 2)} ${n.slice(2, 4)} ${n.slice(4, 6)} ${n.slice(6, 8)}`;
};

export const uniqueEmail = (prefix: string) =>
  `${prefix}.${Date.now()}.${++counter}@test.ci`.toLowerCase();

/** Client HTTP authentifié. */
export class Api {
  constructor(
    private readonly app: INestApplication<App>,
    public token?: string,
  ) {}

  private req(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
  ) {
    const r = request(this.app.getHttpServer())[method](`/api${path}`);
    return this.token ? r.set('Authorization', `Bearer ${this.token}`) : r;
  }

  get(path: string) {
    return this.req('get', path);
  }
  post(path: string, body: object = {}) {
    return this.req('post', path).send(body);
  }
  patch(path: string, body: object = {}) {
    return this.req('patch', path).send(body);
  }
  put(path: string, body: object = {}) {
    return this.req('put', path).send(body);
  }
  delete(path: string) {
    return this.req('delete', path);
  }
}

export interface Actor {
  id: string;
  email: string;
  api: Api;
}

export interface Tenant {
  tenantId: string;
  admin: Actor;
  createUser(
    role: 'agent' | 'team_lead' | 'admin',
    extra?: object,
  ): Promise<Actor>;
  createZone(
    name: string,
    area: object,
    extra?: object,
  ): Promise<{ id: string }>;
  createGroup(
    name: string,
    leaderId: string | null,
    members: string[],
    zones: string[],
  ): Promise<{ id: string }>;
  settings(patch: object): Promise<void>;
}

export async function login(
  app: INestApplication<App>,
  email: string,
): Promise<Api> {
  const res = await new Api(app)
    .post('/auth/login', { email, password: PASSWORD })
    .expect(200);
  return new Api(app, (res.body as { accessToken: string }).accessToken);
}

export async function newTenant(
  app: INestApplication<App>,
  name = 'Structure',
): Promise<Tenant> {
  const email = uniqueEmail('admin');
  const res = await new Api(app)
    .post('/auth/register', {
      organizationName: name,
      firstName: 'Admin',
      lastName: name,
      email,
      password: PASSWORD,
    })
    .expect(201);
  const api = new Api(app, (res.body as { accessToken: string }).accessToken);
  const me = (await api.get('/auth/me').expect(200)).body as {
    user: { id: string; tenantId: string };
  };
  const admin = { id: me.user.id, email, api };

  return {
    tenantId: me.user.tenantId,
    admin,
    async createUser(role, extra = {}) {
      const userEmail = uniqueEmail(role);
      const created = await api
        .post('/users', {
          email: userEmail,
          password: PASSWORD,
          firstName: role,
          lastName: String(counter),
          role,
          ...(role === 'admin' ? {} : { phone: uniquePhone() }),
          ...extra,
        })
        .expect(201);
      return {
        id: (created.body as { id: string }).id,
        email: userEmail,
        api: await login(app, userEmail),
      };
    },
    async createZone(zoneName, area, extra = {}) {
      const created = await api
        .post('/zones', { name: zoneName, area, ...extra })
        .expect(201);
      return created.body as { id: string };
    },
    async createGroup(groupName, leaderId, members, zones) {
      const created = await api
        .post('/groups', { name: groupName, leaderId })
        .expect(201);
      const id = (created.body as { id: string }).id;
      await api.put(`/groups/${id}/members`, { ids: members }).expect(200);
      await api.put(`/groups/${id}/zones`, { ids: zones }).expect(200);
      return { id };
    },
    async settings(patch) {
      await api.patch('/settings', patch).expect(200);
    },
  };
}

/** Rectangle GeoJSON [ouest, sud, est, nord]. */
export const box = (w: number, s: number, e: number, n: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ],
  ],
});

export const PLATEAU = box(-4.03, 5.31, -4.01, 5.33);
export const COCODY = box(-4.0, 5.34, -3.96, 5.37);
export const YOPOUGON = box(-4.1, 5.32, -4.06, 5.36);
export const MARCORY = box(-3.99, 5.29, -3.96, 5.31);
/** Point au centre du Plateau, et un point hors de toute zone. */
export const IN_PLATEAU = { lat: 5.32, lng: -4.02 };
export const OUTSIDE = { lat: 5.5, lng: -4.5 };
