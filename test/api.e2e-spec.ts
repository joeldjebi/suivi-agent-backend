import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/auth/auth.service';
import { stepAt, totp } from '../src/platform/totp';
import { JobsService } from '../src/jobs/jobs.service';
import { SubscriptionsService } from '../src/subscriptions/subscriptions.service';
import {
  Api,
  COCODY,
  createApp,
  IN_PLATEAU,
  login,
  MARCORY,
  newTenant,
  OUTSIDE,
  ownerDataSource,
  PASSWORD,
  PLATEAU,
  resetDatabase,
  uniqueEmail,
  uniquePhone,
  YOPOUGON,
} from './helpers';
import { PushService, type PushMessage } from '../src/common/push.service';
import {
  AppVersionService,
  compareVersions,
} from '../src/app-version/app-version';

type Body = Record<string, any>;

let app: INestApplication<App>;
let owner: DataSource;
let jobs: JobsService;

beforeAll(async () => {
  app = await createApp();
  owner = await ownerDataSource();
  jobs = app.get(JobsService);
  await resetDatabase(app, owner);
});

afterAll(async () => {
  await owner?.destroy();
  await app?.close();
});

const point = (at: Date, where = IN_PLATEAU, extra: object = {}) => ({
  ...where,
  accuracy: 10,
  batteryLevel: 0.8,
  recordedAt: at.toISOString(),
  ...extra,
});

describe('Santé', () => {
  it('GET /health vérifie la base, PostGIS et Redis', async () => {
    const res = await new Api(app).get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      database: 'up',
      redis: 'up',
    });
  });
});

describe('Authentification', () => {
  it('inscrit une structure, connecte, rafraîchit avec rotation et déconnecte', async () => {
    const email = uniqueEmail('owner');
    const register = await new Api(app)
      .post('/auth/register', {
        organizationName: 'Société Test',
        firstName: 'Jo',
        lastName: 'Test',
        email,
        password: PASSWORD,
      })
      .expect(201);
    expect(register.body).toMatchObject({ expiresIn: 900 });

    const me = await new Api(app, register.body.accessToken)
      .get('/auth/me')
      .expect(200);
    expect(me.body.user).toMatchObject({ email, role: 'admin' });
    expect(me.body.tenant.name).toBe('Société Test');
    expect(me.body.settings).toMatchObject({
      approvalMode: 'automatic',
      useGroups: false,
      dailyResetTime: '00:00',
      requestExpirationMinutes: 30,
    });

    await new Api(app)
      .post('/auth/register', {
        organizationName: 'Doublon',
        firstName: 'A',
        lastName: 'B',
        email: email.toUpperCase(),
        password: PASSWORD,
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('EMAIL_TAKEN'));

    await new Api(app)
      .post('/auth/login', { email, password: 'mauvais-mot-de-passe' })
      .expect(401)
      .expect((r) => expect(r.body.code).toBe('INVALID_CREDENTIALS'));

    const loginRes = await new Api(app)
      .post('/auth/login', { email, password: PASSWORD })
      .expect(200);
    const refreshed = await new Api(app)
      .post('/auth/refresh', { refreshToken: loginRes.body.refreshToken })
      .expect(200);
    expect(refreshed.body.refreshToken).not.toBe(loginRes.body.refreshToken);
    // L'ancien jeton de rafraîchissement a été révoqué par la rotation.
    await new Api(app)
      .post('/auth/refresh', { refreshToken: loginRes.body.refreshToken })
      .expect(401);

    await new Api(app)
      .post('/auth/logout', { refreshToken: refreshed.body.refreshToken })
      .expect(204);
    await new Api(app)
      .post('/auth/refresh', { refreshToken: refreshed.body.refreshToken })
      .expect(401);
  });

  it('refuse les appels sans jeton ou avec un jeton invalide', async () => {
    await new Api(app).get('/users').expect(401);
    await new Api(app, 'jeton-invalide').get('/users').expect(401);
  });

  it('change le mot de passe et révoque les sessions', async () => {
    const t = await newTenant(app);
    await t.admin.api
      .patch('/auth/password', {
        currentPassword: 'faux',
        newPassword: 'Nouveau123!',
      })
      .expect(401);
    // Un deuxième appareil connecté avant le changement.
    const other = await login(app, t.admin.email);
    const changed = await t.admin.api
      .patch('/auth/password', {
        currentPassword: PASSWORD,
        newPassword: 'Nouveau123!',
      })
      .expect(200);
    // L'appareil qui change reçoit de nouveaux jetons et reste connecté…
    const fresh = new Api(app, changed.body.accessToken as string);
    await fresh.get('/auth/me').expect(200);
    await new Api(app)
      .post('/auth/refresh', { refreshToken: changed.body.refreshToken })
      .expect(200);
    // …les autres sessions sont coupées.
    await t.admin.api.get('/auth/me').expect(401);
    await other.get('/auth/me').expect(401);
    await new Api(app)
      .post('/auth/login', { email: t.admin.email, password: PASSWORD })
      .expect(401);
    await new Api(app)
      .post('/auth/login', { email: t.admin.email, password: 'Nouveau123!' })
      .expect(200);
  });

  it('chacun met à jour son profil et sa photo, pas son numéro de connexion', async () => {
    const t = await newTenant(app);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const outsider = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [agent.id], []);

    const updated = await agent.api
      .patch('/auth/me', {
        firstName: '  Koffi ',
        lastName: 'Brou',
        email: 'KOFFI.BROU@exemple.ci',
      })
      .expect(200);
    expect(updated.body.user).toMatchObject({
      firstName: 'Koffi',
      lastName: 'Brou',
      email: 'koffi.brou@exemple.ci',
    });
    // Le rôle et le groupe ne se modifient pas soi-même.
    await agent.api.patch('/auth/me', { role: 'admin' }).expect(400);
    await agent.api.patch('/auth/me', { firstName: '' }).expect(400);
    await outsider.api
      .patch('/auth/me', { email: 'koffi.brou@exemple.ci' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('EMAIL_TAKEN'));

    // Le numéro de connexion n'est pas modifiable par l'utilisateur.
    await agent.api.patch('/auth/me', { phone: '0799887766' }).expect(400);
    await agent.api
      .patch('/auth/me/phone', {
        phone: '0799887766',
        currentPassword: PASSWORD,
      })
      .expect(404);

    // Photo de profil.
    const PNG = Buffer.from(
      '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
      'hex',
    );
    const upload = (buffer: Buffer) =>
      request(app.getHttpServer())
        .put('/api/auth/me/avatar')
        .set('Authorization', `Bearer ${agent.api.token}`)
        .attach('file', buffer, 'photo.png');
    await upload(Buffer.from('pas une image'))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('AVATAR_FORMAT'));
    await upload(Buffer.concat([PNG, Buffer.alloc(1100 * 1024)]))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('AVATAR_TOO_LARGE'));
    const withPhoto = await upload(PNG).expect(200);
    expect(withPhoto.body.user.avatarVersion).toBe(1);
    expect(withPhoto.body.user.avatar).toBeUndefined();

    // Visible par soi, son chef et l'administrateur ; pas par un autre agent.
    for (const viewer of [agent, lead, t.admin]) {
      const photo = await viewer.api
        .get(`/users/${agent.id}/avatar`)
        .expect(200);
      expect(photo.headers['content-type']).toBe('image/png');
    }
    await outsider.api.get(`/users/${agent.id}/avatar`).expect(403);

    const removed = await agent.api.delete('/auth/me/avatar').expect(200);
    expect(removed.body.user.avatarVersion).toBeNull();
    await agent.api.get(`/users/${agent.id}/avatar`).expect(404);
  });

  it('valide les données envoyées et rejette les champs inconnus', async () => {
    await new Api(app)
      .post('/auth/register', {
        organizationName: 'X',
        email: 'pas-un-email',
        password: '123',
      })
      .expect(400);
    await new Api(app)
      .post('/auth/login', { email: 'a@b.ci', password: 'x', inconnu: true })
      .expect(400);
  });
});

describe('Isolation des structures (multi-tenant)', () => {
  it("une structure ne voit jamais les données d'une autre", async () => {
    const a = await newTenant(app, 'A');
    const b = await newTenant(app, 'B');
    const zoneA = await a.createZone('Plateau A', PLATEAU);
    const agentA = await a.createUser('agent');

    const zonesB = await b.admin.api.get('/zones').expect(200);
    expect(zonesB.body).toEqual([]);
    const usersB = await b.admin.api.get('/users').expect(200);
    expect(usersB.body.items.map((u: Body) => u.id)).toEqual([b.admin.id]);

    await b.admin.api.get(`/zones/${zoneA.id}`).expect(404);
    await b.admin.api.get(`/users/${agentA.id}`).expect(404);
    await b.admin.api
      .patch(`/users/${agentA.id}`, { firstName: 'Pirate' })
      .expect(404);

    // Le contrôle de chevauchement est propre à chaque structure.
    await b.createZone('Plateau B', PLATEAU);
  });

  it('la Row Level Security bloque les lectures sans structure, même en SQL direct', async () => {
    const a = await newTenant(app, 'RLS');
    await a.createUser('agent');
    await owner.transaction(async (m) => {
      await m.query(`SET LOCAL ROLE suivi_app`);
      const [none] = await m.query(`SELECT count(*)::int AS n FROM users`);
      expect(none.n).toBe(0);
      await m.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        a.tenantId,
      ]);
      const [own] = await m.query(`SELECT count(*)::int AS n FROM users`);
      expect(own.n).toBe(2);
      await expect(
        m.query(
          `INSERT INTO zones (tenant_id, name, area) VALUES (gen_random_uuid(), 'x', ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 4326))`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe('Paramètres de la structure', () => {
  it("seul l'administrateur modifie les paramètres, avec validation", async () => {
    const t = await newTenant(app);
    const agent = await t.createUser('agent');

    await agent.api.get('/settings').expect(200);
    await agent.api.patch('/settings', { approvalMode: 'manual' }).expect(403);
    await t.admin.api
      .patch('/settings', { timezone: 'Mars/Olympus' })
      .expect(400);
    await t.admin.api
      .patch('/settings', { dailyResetTime: '25:00' })
      .expect(400);
    await t.admin.api
      .patch('/settings', { approvalMode: 'inconnu' })
      .expect(400);
    await t.admin.api.patch('/settings', { champInconnu: 1 }).expect(400);

    const res = await t.admin.api
      .patch('/settings', {
        approvalMode: 'mixed',
        mixedCriteria: {
          sensitiveZone: true,
          fillThresholdPercent: 80,
          zoneChange: true,
          probationAgent: false,
        },
        dailyResetTime: '04:30',
        trackDuringPause: true,
      })
      .expect(200);
    expect(res.body).toMatchObject({
      approvalMode: 'mixed',
      dailyResetTime: '04:30',
      trackDuringPause: true,
      mixedCriteria: { fillThresholdPercent: 80, zoneChange: true },
    });
  });
});

describe('Utilisateurs et groupes', () => {
  it('gère les rôles, les groupes et le périmètre du chef d’équipe', async () => {
    const t = await newTenant(app);
    const lead1 = await t.createUser('team_lead');
    const lead2 = await t.createUser('team_lead');
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');
    const a3 = await t.createUser('agent');

    await lead1.api
      .post('/users', {
        email: uniqueEmail('x'),
        password: PASSWORD,
        firstName: 'x',
        lastName: 'y',
        role: 'agent',
      })
      .expect(403);
    await t.admin.api
      .post('/users', {
        email: a1.email,
        password: PASSWORD,
        firstName: 'x',
        lastName: 'y',
        role: 'agent',
      })
      .expect(409);

    // Le chef doit avoir le rôle team_lead.
    await t.admin.api
      .post('/groups', { name: 'Mauvais', leaderId: a1.id })
      .expect(400);

    const north = await t.createGroup('Nord', lead1.id, [a1.id, a2.id], []);
    const south = await t.createGroup('Sud', lead2.id, [a3.id], []);

    const groups = await t.admin.api.get('/groups').expect(200);
    expect(groups.body.map((g: Body) => [g.name, g.agentCount])).toEqual([
      ['Nord', 2],
      ['Sud', 1],
    ]);

    // Un agent ne peut appartenir qu'à un seul groupe : il change de groupe.
    await t.admin.api
      .put(`/groups/${south.id}/members`, { ids: [a3.id, a2.id] })
      .expect(200);
    const detail = await t.admin.api.get(`/groups/${north.id}`).expect(200);
    expect(detail.body.members.map((m: Body) => m.id)).toEqual([a1.id]);

    const leadUsers = await lead1.api.get('/users').expect(200);
    expect(leadUsers.body.items.map((u: Body) => u.id)).toEqual([a1.id]);
    expect((await lead1.api.get('/groups').expect(200)).body).toHaveLength(1);
    await lead1.api.get(`/groups/${south.id}`).expect(403);
    await lead1.api.get(`/users/${a3.id}`).expect(403);
    await lead1.api.get(`/users/${a1.id}`).expect(200);

    await a1.api.get('/users').expect(403);
    await a1.api.get(`/users/${a1.id}`).expect(200);

    // Seuls les agents appartiennent à un groupe.
    await t.admin.api
      .patch(`/users/${lead1.id}`, { groupId: north.id })
      .expect(400);

    // Désactivation : le compte ne peut plus se connecter.
    await t.admin.api.patch(`/users/${a1.id}`, { isActive: false }).expect(200);
    await new Api(app)
      .post('/auth/login', { email: a1.email, password: PASSWORD })
      .expect(401);
    await t.admin.api
      .patch(`/users/${t.admin.id}`, { isActive: false })
      .expect(403);
  });
});

describe('Zones', () => {
  it('valide le polygone et interdit les chevauchements', async () => {
    const t = await newTenant(app);
    const bowtie = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 1],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    };
    await t.admin.api
      .post('/zones', { name: 'Papillon', area: bowtie })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_AREA'));
    await t.admin.api
      .post('/zones', {
        name: 'Ouvert',
        area: { type: 'Polygon', coordinates: [[[0, 0]]] },
      })
      .expect(400);

    const plateau = await t.createZone('Plateau', PLATEAU, { capacity: 3 });
    await t.admin.api
      .post('/zones', { name: 'Chevauche', area: { ...PLATEAU } })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ZONE_OVERLAP'));
    // Une zone qui touche seulement le bord est acceptée.
    await t.createZone('Voisine', {
      type: 'Polygon',
      coordinates: [
        [
          [-4.01, 5.31],
          [-4.0, 5.31],
          [-4.0, 5.33],
          [-4.01, 5.33],
          [-4.01, 5.31],
        ],
      ],
    });

    const listed = await t.admin.api.get('/zones').expect(200);
    expect(listed.body).toHaveLength(2);
    expect(listed.body.find((z: Body) => z.id === plateau.id)).toMatchObject({
      capacity: 3,
      taken: 0,
      placesLeft: 3,
      isFull: false,
      area: { type: 'Polygon' },
    });

    const updated = await t.admin.api
      .patch(`/zones/${plateau.id}`, { capacity: 5, sensitive: true })
      .expect(200);
    expect(updated.body).toMatchObject({ capacity: 5, sensitive: true });

    await t.admin.api
      .patch(`/zones/${plateau.id}`, { isActive: false })
      .expect(200);
    expect((await t.admin.api.get('/zones').expect(200)).body).toHaveLength(1);
    expect(
      (await t.admin.api.get('/zones?includeInactive=true').expect(200)).body,
    ).toHaveLength(2);
  });
});

describe('Choix de zone — mode automatique, sans groupes', () => {
  it('approuve, gère le changement de zone et la capacité (RG-03, RG-08, RG-15)', async () => {
    const t = await newTenant(app);
    const plateau = await t.createZone('Plateau', PLATEAU, { capacity: 1 });
    const cocody = await t.createZone('Cocody', COCODY, { capacity: 2 });
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');

    const available = await a1.api.get('/zones/available').expect(200);
    expect(available.body.zones.map((z: Body) => z.name)).toEqual([
      'Cocody',
      'Plateau',
    ]);

    const first = await a1.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(201);
    expect(first.body).toMatchObject({
      status: 'approved',
      requiresApproval: false,
      isChange: false,
    });

    await a1.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ALREADY_IN_ZONE'));

    // Zone pleine : non sélectionnable (RG-03).
    const forA2 = await a2.api.get('/zones/available').expect(200);
    expect(
      forA2.body.zones.find((z: Body) => z.id === plateau.id),
    ).toMatchObject({ isFull: true, placesLeft: 0 });
    await a2.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ZONE_FULL'));

    // Changement de zone avant le démarrage : l'ancienne place est libérée.
    const change = await a1.api
      .post('/zone-requests', { zoneId: cocody.id })
      .expect(201);
    expect(change.body).toMatchObject({ status: 'approved', isChange: true });
    await a2.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);

    const history = await t.admin.api
      .get(`/zone-requests?agentId=${a1.id}`)
      .expect(200);
    expect(
      history.body.items.map((r: Body) => [
        r.zone.name,
        r.status,
        r.releaseReason,
      ]),
    ).toEqual([
      ['Cocody', 'approved', null],
      ['Plateau', 'released', 'zone_change'],
    ]);

    // Changement interdit par la structure (RG-08).
    await t.settings({ allowZoneChangeBeforeStart: false });
    await a1.api.post('/zone-requests', { zoneId: plateau.id }).expect(403);
  });

  it('respecte les zones réservées à certains agents (RG-15)', async () => {
    const t = await newTenant(app);
    const reserved = await t.createZone('Réservée', PLATEAU, {
      restricted: true,
    });
    await t.createZone('Ouverte', COCODY);
    const allowed = await t.createUser('agent');
    const other = await t.createUser('agent');

    // Par défaut, toutes les zones sont accessibles, même marquées réservées.
    expect(
      (await other.api.get('/zones/available').expect(200)).body.zones,
    ).toHaveLength(2);

    await t.settings({ zoneAccessWithoutGroups: 'restricted' });
    await t.admin.api
      .put(`/zones/${reserved.id}/agents`, { ids: [allowed.id] })
      .expect(200);

    expect(
      (await other.api.get('/zones/available').expect(200)).body.zones.map(
        (z: Body) => z.name,
      ),
    ).toEqual(['Ouverte']);
    await other.api.post('/zone-requests', { zoneId: reserved.id }).expect(403);
    expect(
      (await allowed.api.get('/zones/available').expect(200)).body.zones,
    ).toHaveLength(2);
    await allowed.api
      .post('/zone-requests', { zoneId: reserved.id })
      .expect(201);
    expect(
      (await t.admin.api.get(`/zones/${reserved.id}/agents`).expect(200)).body,
    ).toHaveLength(1);
  });

  it('libère les places quand une zone est désactivée', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Temporaire', PLATEAU);
    const agent = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await t.admin.api
      .patch(`/zones/${zone.id}`, { isActive: false })
      .expect(200);
    const current = await agent.api.get('/days/current').expect(200);
    expect(current.body.approved).toBeNull();
    const notifications = await agent.api.get('/notifications').expect(200);
    expect(notifications.body.map((n: Body) => n.type)).toContain(
      'zone.deactivated',
    );
  });
});

describe('Concurrence sur les places', () => {
  it('deux agents ne peuvent pas obtenir la dernière place en même temps', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Dernière place', PLATEAU, { capacity: 1 });
    const agents = await Promise.all(
      [1, 2, 3, 4, 5].map(() => t.createUser('agent')),
    );

    const results = await Promise.all(
      agents.map((a) => a.api.post('/zone-requests', { zoneId: zone.id })),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409]);
    expect(
      results
        .filter((r) => r.status === 409)
        .every((r) => r.body.code === 'ZONE_FULL'),
    ).toBe(true);
    expect(
      (await t.admin.api.get(`/zones/${zone.id}`).expect(200)).body.taken,
    ).toBe(1);
  });
});

describe('Groupes activés (RG-06, RG-33)', () => {
  it("l'agent choisit parmi les zones de son groupe et les zones libres", async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const plateau = await t.createZone('Plateau', PLATEAU);
    const cocody = await t.createZone('Cocody', COCODY);
    const yopougon = await t.createZone('Yopougon', YOPOUGON);
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const member = await t.createUser('agent');
    const orphan = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [member.id], [plateau.id]);
    await t.createGroup('Sud', otherLead.id, [], [cocody.id]);

    // Sans groupe : les zones libres seulement (Yopougon n'est rattachée à aucun groupe).
    const orphanView = await orphan.api.get('/zones/available').expect(200);
    expect(orphanView.body).toMatchObject({ groupMissing: true });
    expect(orphanView.body.zones.map((z: Body) => z.name)).toEqual([
      'Yopougon',
    ]);
    await orphan.api.post('/zone-requests', { zoneId: plateau.id }).expect(403);
    await orphan.api
      .post('/zone-requests', { zoneId: yopougon.id })
      .expect(201);

    // Membre : les zones de son groupe et les zones libres, jamais celles d'un autre groupe.
    expect(
      (await member.api.get('/zones/available').expect(200)).body.zones.map(
        (z: Body) => z.name,
      ),
    ).toEqual(['Plateau', 'Yopougon']);
    await member.api.post('/zone-requests', { zoneId: cocody.id }).expect(403);
    await member.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);

    // Le chef d'équipe voit les zones de ses groupes et les zones libres.
    expect(
      (await lead.api.get('/zones').expect(200)).body.map((z: Body) => z.name),
    ).toEqual(['Plateau', 'Yopougon']);
  });
});

describe('Approbation manuelle (RG-07, RG-16 à RG-20)', () => {
  it('réserve la place, notifie le chef, approuve ou refuse', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true, approvalMode: 'manual' });
    const plateau = await t.createZone('Plateau', PLATEAU, { capacity: 2 });
    const cocody = await t.createZone('Cocody', COCODY, { capacity: 2 });
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [agent.id], [plateau.id, cocody.id]);
    await t.createGroup('Sud', otherLead.id, [], []);

    const pending = await agent.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(201);
    expect(pending.body).toMatchObject({
      status: 'pending',
      requiresApproval: true,
    });
    expect(new Date(pending.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 29 * 60_000,
    );

    // RG-17 : la place est réservée.
    expect(
      (await t.admin.api.get(`/zones/${plateau.id}`).expect(200)).body,
    ).toMatchObject({ taken: 1, placesLeft: 1 });

    const leadNotifications = await lead.api
      .get('/notifications?unreadOnly=true')
      .expect(200);
    expect(leadNotifications.body[0]).toMatchObject({
      type: 'zone_request.created',
    });
    // Sans groupes ni chef, ce serait l'administrateur ; ici il n'est pas notifié.
    expect(
      (await t.admin.api.get('/notifications').expect(200)).body,
    ).toHaveLength(0);

    const queue = await lead.api
      .get('/zone-requests?status=pending')
      .expect(200);
    expect(queue.body.items.map((r: Body) => r.id)).toEqual([pending.body.id]);
    expect(
      (await otherLead.api.get('/zone-requests?status=pending').expect(200))
        .body.items,
    ).toHaveLength(0);

    await otherLead.api
      .post(`/zone-requests/${pending.body.id}/decision`, { approve: true })
      .expect(403);
    await agent.api
      .post(`/zone-requests/${pending.body.id}/decision`, { approve: true })
      .expect(403);
    await agent.api
      .post('/zone-requests', { zoneId: cocody.id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('REQUEST_PENDING'));
    await agent.api
      .post('/days/start')
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PENDING_APPROVAL'));

    // RG-19 : refus, la place est libérée et l'agent notifié.
    const rejected = await lead.api
      .post(`/zone-requests/${pending.body.id}/decision`, {
        approve: false,
        reason: 'Zone déjà couverte',
      })
      .expect(201);
    expect(rejected.body).toMatchObject({
      status: 'rejected',
      decisionReason: 'Zone déjà couverte',
    });
    expect(
      (await t.admin.api.get(`/zones/${plateau.id}`).expect(200)).body.taken,
    ).toBe(0);
    expect(
      (await agent.api.get('/notifications').expect(200)).body[0],
    ).toMatchObject({
      type: 'zone_request.rejected',
    });
    await lead.api
      .post(`/zone-requests/${pending.body.id}/decision`, { approve: true })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('REQUEST_NOT_PENDING'));

    const again = await agent.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(201);
    const approved = await lead.api
      .post(`/zone-requests/${again.body.id}/decision`, { approve: true })
      .expect(201);
    expect(approved.body).toMatchObject({
      status: 'approved',
      decidedById: lead.id,
    });

    // RG-20 : pendant l'attente d'un changement, l'agent garde sa zone et sa place.
    const change = await agent.api
      .post('/zone-requests', { zoneId: cocody.id })
      .expect(201);
    expect(change.body).toMatchObject({ status: 'pending', isChange: true });
    const current = await agent.api.get('/days/current').expect(200);
    expect(current.body.approved.zoneId).toBe(plateau.id);
    expect(current.body.pending.zoneId).toBe(cocody.id);
    expect(
      (await t.admin.api.get(`/zones/${plateau.id}`).expect(200)).body.taken,
    ).toBe(1);
    expect(
      (await t.admin.api.get(`/zones/${cocody.id}`).expect(200)).body.taken,
    ).toBe(1);

    // L'agent annule sa demande de changement.
    await agent.api.post(`/zone-requests/${change.body.id}/cancel`).expect(201);
    expect(
      (await t.admin.api.get(`/zones/${cocody.id}`).expect(200)).body.taken,
    ).toBe(0);
    expect(
      (await agent.api.get('/days/current').expect(200)).body.approved.zoneId,
    ).toBe(plateau.id);
  });

  it("sans groupes, l'administrateur approuve (RG-16)", async () => {
    const t = await newTenant(app);
    await t.settings({ approvalMode: 'manual' });
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    const pending = await agent.api
      .post('/zone-requests', { zoneId: zone.id })
      .expect(201);
    expect(
      (await t.admin.api.get('/notifications').expect(200)).body[0],
    ).toMatchObject({
      type: 'zone_request.created',
      data: { requestId: pending.body.id },
    });
    await t.admin.api
      .post(`/zone-requests/${pending.body.id}/decision`, { approve: true })
      .expect(201);
  });
});

describe('Mode mixte (RG-23, RG-24)', () => {
  it('demande une approbation seulement si un critère activé est rempli', async () => {
    const t = await newTenant(app);
    await t.settings({
      approvalMode: 'mixed',
      mixedCriteria: {
        sensitiveZone: true,
        fillThresholdPercent: 75,
        zoneChange: false,
        probationAgent: true,
      },
    });
    const sensitive = await t.createZone('Sensible', PLATEAU, {
      sensitive: true,
    });
    const normal = await t.createZone('Normale', COCODY);
    const busy = await t.createZone('Remplie', YOPOUGON, { capacity: 4 });
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');
    const a3 = await t.createUser('agent');
    const a4 = await t.createUser('agent');
    const probation = await t.createUser('agent', { onProbation: true });

    expect(
      (
        await a1.api
          .post('/zone-requests', { zoneId: sensitive.id })
          .expect(201)
      ).body.status,
    ).toBe('pending');
    expect(
      (await a2.api.post('/zone-requests', { zoneId: normal.id }).expect(201))
        .body.status,
    ).toBe('approved');
    expect(
      (
        await probation.api
          .post('/zone-requests', { zoneId: normal.id })
          .expect(201)
      ).body.status,
    ).toBe('pending');

    // Seuil de remplissage : 2/4 = 50 % (approuvé), puis 3/4 = 75 % (approbation manuelle).
    expect(
      (await a3.api.post('/zone-requests', { zoneId: busy.id }).expect(201))
        .body.status,
    ).toBe('approved');
    expect(
      (await a4.api.post('/zone-requests', { zoneId: busy.id }).expect(201))
        .body.status,
    ).toBe('approved');
    const third = await t.createUser('agent');
    expect(
      (await third.api.post('/zone-requests', { zoneId: busy.id }).expect(201))
        .body.status,
    ).toBe('pending');
  });
});

describe('Expiration et relance des demandes (RG-18, RG-28 à RG-30)', () => {
  it('mode manuel : relance à mi-délai puis libération de la place', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true, approvalMode: 'manual' });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    const pending = await agent.api
      .post('/zone-requests', { zoneId: zone.id })
      .expect(201);

    await owner.query(
      `UPDATE zone_requests SET created_at = now() - interval '20 minutes', expires_at = now() + interval '10 minutes' WHERE id = $1`,
      [pending.body.id],
    );
    await jobs.everyMinute();
    const leadTypes = (
      await lead.api.get('/notifications').expect(200)
    ).body.map((n: Body) => n.type);
    expect(leadTypes).toContain('zone_request.reminder');
    // RG-29 : la demande remonte aussi à l'administrateur.
    expect(
      (await t.admin.api.get('/notifications').expect(200)).body[0].type,
    ).toBe('zone_request.reminder');

    await owner.query(
      `UPDATE zone_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [pending.body.id],
    );
    await jobs.everyMinute();
    const [request] = (
      await t.admin.api.get(`/zone-requests?agentId=${agent.id}`).expect(200)
    ).body.items;
    expect(request).toMatchObject({
      status: 'expired',
      releaseReason: 'expired',
    });
    expect(
      (await t.admin.api.get(`/zones/${zone.id}`).expect(200)).body.taken,
    ).toBe(0);
    expect(
      (await agent.api.get('/notifications').expect(200)).body[0].type,
    ).toBe('zone_request.expired');
  });

  it('mode mixte : approbation automatique à l’expiration (par défaut)', async () => {
    const t = await newTenant(app);
    await t.settings({ approvalMode: 'mixed' });
    const zone = await t.createZone('Sensible', PLATEAU, { sensitive: true });
    const agent = await t.createUser('agent');
    const pending = await agent.api
      .post('/zone-requests', { zoneId: zone.id })
      .expect(201);
    await owner.query(
      `UPDATE zone_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [pending.body.id],
    );
    await jobs.everyMinute();
    const current = await agent.api.get('/days/current').expect(200);
    expect(current.body.approved).toMatchObject({
      id: pending.body.id,
      decisionReason: 'expired_auto_approved',
    });
  });
});

describe('Journée de travail (RG-09, RG-10, RG-21, RG-25 à RG-27)', () => {
  it('démarre, met en pause, reprend et termine la journée', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const cocody = await t.createZone('Cocody', COCODY);
    const agent = await t.createUser('agent');

    await agent.api
      .post('/days/start')
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ZONE_REQUIRED'));
    await agent.api
      .post('/days/pause')
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('NO_OPEN_DAY'));

    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const started = await agent.api.post('/days/start').expect(200);
    expect(started.body).toMatchObject({
      status: 'active',
      zoneId: zone.id,
      pauses: [],
    });
    await agent.api
      .post('/days/start')
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DAY_ALREADY_STARTED'));

    // RG-09 : plus de changement de zone une fois la journée démarrée.
    await agent.api
      .post('/zone-requests', { zoneId: cocody.id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DAY_STARTED'));

    expect((await agent.api.post('/days/pause').expect(200)).body.status).toBe(
      'paused',
    );
    await agent.api.post('/days/pause').expect(409);
    const resumed = await agent.api.post('/days/resume').expect(200);
    expect(resumed.body.status).toBe('active');
    expect(resumed.body.pauses).toHaveLength(1);
    expect(resumed.body.pauses[0].endedAt).not.toBeNull();
    await agent.api.post('/days/resume').expect(409);

    const ended = await agent.api.post('/days/end').expect(200);
    expect(ended.body).toMatchObject({ status: 'ended', endReason: 'manual' });
    expect(typeof ended.body.workedSeconds).toBe('number');
    expect(typeof ended.body.pausedSeconds).toBe('number');

    // RG-21 : la place est libérée en fin de journée.
    expect((await agent.api.get('/days/current').expect(200)).body).toEqual({
      day: null,
      approved: null,
      pending: null,
    });
    expect(
      (await t.admin.api.get(`/zones/${zone.id}`).expect(200)).body.taken,
    ).toBe(0);

    const history = await t.admin.api
      .get(`/days?agentId=${agent.id}`)
      .expect(200);
    expect(history.body.total).toBe(1);
    expect(history.body.items[0]).toMatchObject({
      status: 'ended',
      agent: { id: agent.id },
    });
    await t.admin.api.get(`/days/${started.body.id}`).expect(200);
  });

  it('démarre sans zone si la structure le permet (RG-26, RG-27)', async () => {
    const t = await newTenant(app);
    const agent = await t.createUser('agent');
    await t.settings({ zoneRequired: false });
    const day = await agent.api.post('/days/start').expect(200);
    expect(day.body.zoneId).toBeNull();
    await agent.api.post('/days/end').expect(200);

    // Démarrage pendant l'attente : la journée reçoit la zone à l'approbation.
    await t.settings({
      zoneRequired: true,
      approvalMode: 'manual',
      startWhilePending: true,
    });
    const zone = await t.createZone('Plateau', PLATEAU);
    const pending = await agent.api
      .post('/zone-requests', { zoneId: zone.id })
      .expect(201);
    const pendingDay = await agent.api.post('/days/start').expect(200);
    expect(pendingDay.body.zoneId).toBeNull();
    await t.admin.api
      .post(`/zone-requests/${pending.body.id}/decision`, { approve: true })
      .expect(201);
    expect(
      (await agent.api.get('/days/current').expect(200)).body.day.zoneId,
    ).toBe(zone.id);
  });
});

describe('Positions et carte en temps réel (RG-11, RG-12)', () => {
  it('enregistre les lots, ignore les doublons et marque les positions hors zone', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;

    const now = Date.now();
    const batch = {
      dayId: day.id,
      points: [
        point(new Date(now - 60_000)),
        point(new Date(now - 30_000), OUTSIDE, { isMocked: true }),
        point(new Date(now - 3600_000)), // avant le démarrage de la journée
      ],
    };
    expect(
      (await agent.api.post('/positions/batch', batch).expect(200)).body,
    ).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: 1,
    });
    // Renvoi du même lot après une coupure réseau.
    expect(
      (await agent.api.post('/positions/batch', batch).expect(200)).body,
    ).toEqual({
      accepted: 0,
      duplicates: 2,
      rejected: 1,
    });
    await other.api.post('/positions/batch', batch).expect(404);
    await agent.api
      .post('/positions/batch', {
        dayId: day.id,
        points: [{ lat: 200, lng: 0 }],
      })
      .expect(400);

    const track = await t.admin.api
      .get(`/days/${day.id}/positions`)
      .expect(200);
    expect(track.body.map((p: Body) => [p.outsideZone, p.isMocked])).toEqual([
      [false, false],
      [true, true],
    ]);

    // Laisser le temps à la mise à jour Redis faite après validation.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const live = await t.admin.api.get('/live').expect(200);
    expect(live.body).toHaveLength(1);
    expect(live.body[0]).toMatchObject({
      status: 'active',
      zoneId: zone.id,
      signalLost: false,
      agent: { id: agent.id },
      position: {
        lat: OUTSIDE.lat,
        outsideZone: true,
        isMocked: true,
        batteryLevel: 0.8,
      },
    });
    expect(
      (await t.admin.api.get('/live?status=paused').expect(200)).body,
    ).toHaveLength(0);
    await agent.api.get('/live').expect(403);
  });

  it('ne suit pas la pause sauf si la structure l’active (RG-12)', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;
    await owner.query(
      `UPDATE work_days SET started_at = now() - interval '1 hour' WHERE id = $1`,
      [day.id],
    );
    await agent.api.post('/days/pause').expect(200);
    await owner.query(
      `UPDATE day_pauses SET started_at = now() - interval '10 minutes' WHERE day_id = $1`,
      [day.id],
    );

    const duringPause = {
      dayId: day.id,
      points: [point(new Date(Date.now() - 5 * 60_000))],
    };
    expect(
      (await agent.api.post('/positions/batch', duringPause).expect(200)).body
        .rejected,
    ).toBe(1);

    await t.settings({ trackDuringPause: true });
    expect(
      (await agent.api.post('/positions/batch', duringPause).expect(200)).body
        .accepted,
    ).toBe(1);
  });

  it('affiche « signal perdu » sans position récente', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;
    await owner.query(
      `UPDATE work_days SET started_at = now() - interval '30 minutes' WHERE id = $1`,
      [day.id],
    );
    const live = await t.admin.api.get('/live').expect(200);
    expect(live.body[0]).toMatchObject({ signalLost: true, position: null });
  });

  it('diffuse la position en temps réel par Socket.IO', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;

    const url = await app.getUrl();
    const socket: Socket = io(url.replace('[::1]', 'localhost'), {
      auth: { token: t.admin.api.token },
      transports: ['websocket'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      // Laisser le serveur placer le client dans ses salles.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const received = new Promise<Body>((resolve) =>
        socket.on('agent:position', resolve),
      );
      await agent.api
        .post('/positions/batch', {
          dayId: day.id,
          points: [point(new Date())],
        })
        .expect(200);
      expect(await received).toMatchObject({
        agentId: agent.id,
        dayId: day.id,
        lat: IN_PLATEAU.lat,
      });
    } finally {
      socket.disconnect();
    }

    // Sans jeton, la connexion est fermée par le serveur.
    const anonymous = io(url.replace('[::1]', 'localhost'), {
      transports: ['websocket'],
    });
    await new Promise<void>((resolve) =>
      anonymous.on('disconnect', () => resolve()),
    );
    anonymous.disconnect();
  });
});

describe('Mon équipe (agent)', () => {
  it('l’agent voit son groupe, son chef, ses zones et ses participations', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const plateau = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const cocody = await t.createZone('Cocody', COCODY);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const loner = await t.createUser('agent');

    // Sans groupe : aucune zone, et l'app peut l'expliquer.
    // Sans groupe : les zones libres (aucune n'est encore rattachée à un groupe).
    let team = (await agent.api.get('/me/team').expect(200)).body;
    expect(team).toMatchObject({
      usesGroups: true,
      group: null,
      groupMissing: true,
      leads: [],
    });
    expect(team.zones.map((z: Body) => z.name)).toEqual(['Cocody', 'Plateau']);

    const group = await t.createGroup(
      'Nord',
      lead.id,
      [agent.id],
      [plateau.id],
    );
    team = (await agent.api.get('/me/team').expect(200)).body;
    expect(team).toMatchObject({
      group: { id: group.id, name: 'Nord', members: 1 },
      groupMissing: false,
    });
    // Plateau (son groupe) et Cocody (zone libre).
    expect(team.zones).toEqual([
      { id: expect.any(String), name: 'Cocody', capacity: null },
      { id: plateau.id, name: 'Plateau', capacity: 5 },
    ]);
    expect(team.leads).toHaveLength(1);
    expect(team.leads[0]).toMatchObject({
      id: lead.id,
      firstName: 'team_lead',
    });
    expect(team.leads[0].phone).toBeTruthy();
    expect(team.leads[0]).not.toHaveProperty('email');

    // Missions : assignées à lui ou à son groupe, avec ses formulaires envoyés.
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [{ key: 'nom', label: 'Nom', type: 'text', required: true }],
        })
        .expect(201)
    ).body as { id: string };
    const due = new Date(Date.now() + 5 * 86400_000).toISOString();
    const create = (body: object) =>
      t.admin.api
        .post('/missions', {
          zoneIds: [plateau.id],
          typeId: type.id,
          progressMethod: 'count',
          targetValue: 10,
          dueDate: due,
          ...body,
        })
        .expect(201);
    const mine = (await create({ title: 'Perso', assigneeAgentId: agent.id }))
      .body as { id: string };
    const ours = (await create({ title: 'Groupe', assigneeGroupId: group.id }))
      .body as { id: string };
    // L'agent sans groupe ne peut travailler que dans une zone libre (Cocody).
    await t.admin.api
      .post('/missions', {
        zoneIds: [plateau.id],
        typeId: type.id,
        title: 'Refusée',
        assigneeAgentId: loner.id,
        progressMethod: 'count',
        targetValue: 1,
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('ZONE_NOT_ACCESSIBLE'));
    await t.admin.api
      .post('/missions', {
        zoneIds: [cocody.id],
        typeId: type.id,
        title: 'Autre',
        assigneeAgentId: loner.id,
        progressMethod: 'count',
        targetValue: 1,
      })
      .expect(201);

    await agent.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    await agent.api
      .post(`/missions/${ours.id}/submissions`, {
        clientId: '7b0c1a2e-0000-4000-8000-000000000001',
        data: { nom: 'Boutique A' },
        submittedAt: new Date().toISOString(),
      })
      .expect(201);

    const list = (await agent.api.get('/missions').expect(200)).body.items as {
      id: string;
      title: string;
      myForms: number;
      assigneeAgentId: string | null;
      assigneeGroupId: string | null;
    }[];
    expect(list.map((m) => m.title).sort()).toEqual(['Groupe', 'Perso']);
    expect(list.find((m) => m.id === ours.id)).toMatchObject({
      myForms: 1,
      assigneeGroupId: group.id,
    });
    expect(list.find((m) => m.id === mine.id)).toMatchObject({
      myForms: 0,
      assigneeAgentId: agent.id,
    });
    // Le compteur est propre aux agents.
    const adminList = (await t.admin.api.get('/missions').expect(200)).body
      .items as Body[];
    expect(adminList[0]).not.toHaveProperty('myForms');

    // Réservé aux agents.
    await lead.api.get('/me/team').expect(403);
    await t.admin.api.get('/me/team').expect(403);
  });

  it('sans groupes : les chefs de la structure et toutes les zones ouvertes', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const team = (await agent.api.get('/me/team').expect(200)).body;
    expect(team).toMatchObject({
      usesGroups: false,
      group: null,
      groupMissing: false,
      zones: [{ id: zone.id }],
    });
    expect(team.leads.map((l: Body) => l.id)).toEqual([lead.id]);
  });
});

describe('Notifications push', () => {
  it('téléphones enregistrés, envoi à chaque notification, jetons périmés oubliés', async () => {
    const push = app.get(PushService);
    const sent: { tokens: string[]; message: PushMessage }[] = [];
    let invalid: string[] = [];
    push.transport = {
      send: (tokens, message) => {
        sent.push({ tokens: tokens.map((t) => t.token), message });
        return Promise.resolve({ invalid });
      },
    };
    try {
      const t = await newTenant(app);
      await t.settings({ useGroups: true, approvalMode: 'manual' });
      const zone = await t.createZone('Plateau', PLATEAU);
      const lead = await t.createUser('team_lead');
      const agent = await t.createUser('agent');
      await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
      const leadToken = `lead-${'x'.repeat(30)}`;
      const agentToken = `agent-${'y'.repeat(30)}`;

      await lead.api
        .post('/devices', {
          token: leadToken,
          platform: 'ios',
          appVersion: '1.0.0',
        })
        .expect(204);
      await agent.api
        .post('/devices', { token: agentToken, platform: 'android' })
        .expect(204);
      await agent.api
        .post('/devices', { token: agentToken, platform: 'web' })
        .expect(400);
      await new Api(app)
        .post('/devices', { token: agentToken, platform: 'android' })
        .expect(401);

      // Demande de zone : le chef est prévenu sur son téléphone, avec de quoi décider.
      const request = (
        await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201)
      ).body as { id: string };
      await new Promise((r) => setTimeout(r, 200));
      const toLead = sent.find(
        (s) => s.message.type === 'zone_request.created',
      )!;
      expect(toLead.tokens).toEqual([leadToken]);
      expect(toLead.message).toMatchObject({
        title: 'Demande de zone à approuver',
        data: { requestId: request.id, zoneId: zone.id },
      });

      // Décision : l'agent est prévenu.
      await lead.api
        .post(`/zone-requests/${request.id}/decision`, { approve: true })
        .expect(201);
      await new Promise((r) => setTimeout(r, 200));
      expect(
        sent.find((s) => s.message.type === 'zone_request.approved')?.tokens,
      ).toEqual([agentToken]);

      // Le téléphone change de compte : le jeton suit le dernier connecté.
      const other = await t.createUser('agent');
      await other.api
        .post('/devices', { token: agentToken, platform: 'android' })
        .expect(204);
      const [{ owner: holder }] = await owner.query<{ owner: string }[]>(
        `SELECT user_id AS owner FROM push_devices WHERE token = $1`,
        [agentToken],
      );
      expect(holder).toBe(other.id);
      // Seul son détenteur le retire (déconnexion).
      await agent.api.delete(`/devices/${agentToken}`).expect(204);
      await other.api.delete(`/devices/${agentToken}`).expect(204);
      expect(
        await owner.query(`SELECT 1 FROM push_devices WHERE token = $1`, [
          agentToken,
        ]),
      ).toHaveLength(0);

      // Application désinstallée : Firebase signale le jeton, il est oublié.
      invalid = [leadToken];
      await push.sendToUsers(t.tenantId, [lead.id], {
        type: 'team.message',
        title: 'Test',
      });
      expect(
        await owner.query(`SELECT 1 FROM push_devices WHERE token = $1`, [
          leadToken,
        ]),
      ).toHaveLength(0);
      // Plus de téléphone : rien n'est envoyé.
      const before = sent.length;
      await push.sendToUsers(t.tenantId, [lead.id], {
        type: 'team.message',
        title: 'Test',
      });
      expect(sent.length).toBe(before);

      // Formule sans notifications push (Base) : rien, sauf les avis d'abonnement.
      await lead.api
        .post('/devices', { token: leadToken, platform: 'ios' })
        .expect(204);
      await owner.query(
        `UPDATE subscriptions SET plan_code = 'base', status = 'active', trial_ends_at = NULL WHERE tenant_id = $1`,
        [t.tenantId],
      );
      app.get(SubscriptionsService).invalidate(t.tenantId);
      const count = sent.length;
      await push.sendToUsers(t.tenantId, [lead.id], {
        type: 'team.message',
        title: 'Réunion',
      });
      expect(sent.length).toBe(count);
      await push.sendToUsers(t.tenantId, [lead.id], {
        type: 'subscription.suspended',
        title: 'Abonnement suspendu',
      });
      expect(sent.at(-1)?.message.type).toBe('subscription.suspended');
      // Structure de test retirée : la formule Base redevient inutilisée.
      await owner.query(`DELETE FROM tenants WHERE id = $1`, [t.tenantId]);
    } finally {
      push.transport = null;
    }
  });
});

describe('Notifications de l’administrateur aux équipes', () => {
  it('par rôle, personnes, zones et missions ; formule, aperçu et historique', async () => {
    const push = app.get(PushService);
    const sent: { tokens: string[]; message: PushMessage }[] = [];
    push.transport = {
      send: (tokens, message) => {
        sent.push({ tokens: tokens.map((t) => t.token), message });
        return Promise.resolve({ invalid: [] });
      },
    };
    try {
      const t = await newTenant(app);
      await t.settings({ useGroups: true });
      const plateau = await t.createZone('Plateau', PLATEAU);
      const cocody = await t.createZone('Cocody', COCODY);
      const lead = await t.createUser('team_lead');
      const otherLead = await t.createUser('team_lead');
      const north = await t.createUser('agent');
      const south = await t.createUser('agent');
      const loner = await t.createUser('agent');
      await t.createGroup('Nord', lead.id, [north.id], [plateau.id]);
      await t.createGroup('Sud', otherLead.id, [south.id], []);
      // L'agent sans groupe a travaillé à Cocody (zone libre) il y a 3 jours.
      await owner.query(
        `INSERT INTO work_days (tenant_id, agent_id, zone_id, status, work_date, started_at)
         VALUES ($1, $2, $3, 'ended', current_date - 3, now() - interval '3 days')`,
        [t.tenantId, loner.id, cocody.id],
      );
      await north.api
        .post('/devices', {
          token: `north-${'n'.repeat(30)}`,
          platform: 'android',
        })
        .expect(204);

      const preview = async (audience: object) =>
        (
          await t.admin.api
            .post('/broadcasts/preview', { audience })
            .expect(201)
        ).body as {
          total: number;
          agents: number;
          leads: number;
          reachable: number;
          sample: string[];
        };

      expect(await preview({ target: 'all' })).toMatchObject({
        total: 5,
        agents: 3,
        leads: 2,
        reachable: 1,
      });
      expect(await preview({ target: 'agents' })).toMatchObject({ total: 3 });
      expect(await preview({ target: 'leads' })).toMatchObject({ total: 2 });
      expect(
        await preview({ target: 'users', userIds: [south.id, lead.id] }),
      ).toMatchObject({ total: 2, agents: 1, leads: 1 });
      // Zone : agents de ses groupes, et ceux qui y ont travaillé ; chefs en option.
      expect(
        await preview({ target: 'zones', zoneIds: [plateau.id] }),
      ).toMatchObject({ total: 1, agents: 1, leads: 0 });
      expect(
        await preview({
          target: 'zones',
          zoneIds: [plateau.id, cocody.id],
          includeLeads: true,
        }),
      ).toMatchObject({ total: 3, agents: 2, leads: 1 });

      // Missions : assignée à un groupe, à un agent, ou ouverte (agents de ses zones).
      const type = (
        await t.admin.api
          .post('/mission-types', {
            name: 'Visite',
            fields: [
              { key: 'nom', label: 'Nom', type: 'text', required: true },
            ],
          })
          .expect(201)
      ).body as { id: string };
      const mission = async (body: object) =>
        (
          await t.admin.api
            .post('/missions', {
              typeId: type.id,
              progressMethod: 'count',
              targetValue: 5,
              ...body,
            })
            .expect(201)
        ).body as { id: string };
      const forNorth = await mission({
        title: 'Groupe Nord',
        zoneIds: [plateau.id],
        assigneeGroupId: (
          await owner.query<{ id: string }[]>(
            `SELECT id FROM groups WHERE leader_id = $1`,
            [lead.id],
          )
        )[0].id,
      });
      const open = await mission({ title: 'Ouverte', zoneIds: [cocody.id] });
      expect(
        await preview({ target: 'missions', missionIds: [forNorth.id] }),
      ).toMatchObject({ total: 1, agents: 1 });
      expect(
        await preview({
          target: 'missions',
          missionIds: [forNorth.id, open.id],
          includeLeads: true,
        }),
      ).toMatchObject({ total: 3, agents: 2, leads: 1 });

      // Sélection vide ou invalide.
      await t.admin.api
        .post('/broadcasts/preview', { audience: { target: 'zones' } })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('EMPTY_SELECTION'));
      await t.admin.api
        .post('/broadcasts/preview', {
          audience: { target: 'users', userIds: [t.admin.id] },
        })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('UNKNOWN_RECIPIENT'));
      await t.admin.api
        .post('/broadcasts/preview', { audience: { target: 'everyone' } })
        .expect(400);

      // Envoi : notification dans l'app et sur les téléphones, tracée.
      const result = (
        await t.admin.api
          .post('/broadcasts', {
            title: 'Réunion demain',
            body: 'Rendez-vous à 8 h au siège.',
            audience: { target: 'zones', zoneIds: [plateau.id] },
          })
          .expect(201)
      ).body as { id: string; recipients: number; reachable: number };
      expect(result).toMatchObject({ recipients: 1, reachable: 1 });
      await new Promise((r) => setTimeout(r, 200));
      expect(sent.at(-1)?.message).toMatchObject({
        type: 'broadcast',
        title: 'Réunion demain',
        body: 'Rendez-vous à 8 h au siège.',
        data: { broadcastId: result.id },
      });
      const inbox = (await north.api.get('/notifications').expect(200))
        .body as { type: string; title: string }[];
      expect(inbox[0]).toMatchObject({
        type: 'broadcast',
        title: 'Réunion demain',
      });
      const history = (await t.admin.api.get('/broadcasts').expect(200))
        .body as {
        title: string;
        recipients: number;
        authorName: string;
        audience: { target: string };
      }[];
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        title: 'Réunion demain',
        recipients: 1,
        audience: { target: 'zones' },
      });

      // Réservé à l'administrateur, et à la formule avec notifications push.
      await lead.api.get('/broadcasts').expect(403);
      await owner.query(
        `UPDATE subscriptions SET plan_code = 'base', status = 'active', trial_ends_at = NULL WHERE tenant_id = $1`,
        [t.tenantId],
      );
      app.get(SubscriptionsService).invalidate(t.tenantId);
      await t.admin.api
        .get('/broadcasts')
        .expect(402)
        .expect((r) => expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN'));
      await owner.query(`DELETE FROM tenants WHERE id = $1`, [t.tenantId]);
    } finally {
      push.transport = null;
    }
  });

  it('modifier un chef : identité et groupes dirigés', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const lead = await t.createUser('team_lead');
    const g1 = await t.createGroup('Nord', lead.id, [], []);
    const g2 = await t.createGroup('Sud', null, [], []);
    await t.admin.api
      .patch(`/users/${lead.id}`, {
        firstName: 'Awa',
        ledGroupIds: [g2.id],
      })
      .expect(200)
      .expect((r) => expect(r.body.firstName).toBe('Awa'));
    const led = await owner.query<{ id: string; leader: string | null }[]>(
      `SELECT id, leader_id AS leader FROM groups WHERE id = ANY($1)`,
      [[g1.id, g2.id]],
    );
    expect(led.find((g) => g.id === g1.id)?.leader).toBeNull();
    expect(led.find((g) => g.id === g2.id)?.leader).toBe(lead.id);
    const detail = (await t.admin.api.get(`/team-leads/${lead.id}`).expect(200))
      .body as { lead: { firstName: string; groups: { id: string }[] } };
    expect(detail.lead.firstName).toBe('Awa');
    expect(detail.lead.groups.map((g) => g.id)).toEqual([g2.id]);
    await t.admin.api
      .patch(`/users/${lead.id}`, { ledGroupIds: [randomUUID()] })
      .expect(404);

    // Numéro de connexion : modifiable tant que le compte ne s'est jamais connecté.
    const email = uniqueEmail('lead');
    const fresh = (
      await t.admin.api
        .post('/users', {
          email,
          password: PASSWORD,
          firstName: 'Nouveau',
          lastName: 'Chef',
          role: 'team_lead',
          phone: uniquePhone(),
        })
        .expect(201)
    ).body as { id: string; phone: string };
    const corrected = uniquePhone();
    await t.admin.api
      .patch(`/users/${fresh.id}`, { phone: corrected })
      .expect(200);
    await login(app, email);
    await t.admin.api
      .patch(`/users/${fresh.id}`, { phone: uniquePhone() })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PHONE_LOCKED'));
    // Le même numéro (formulaire renvoyé tel quel) reste accepté.
    await t.admin.api
      .patch(`/users/${fresh.id}`, { phone: corrected, lastName: 'Kouassi' })
      .expect(200);
  });
});

describe('Formulaires avec photo et « Ma semaine »', () => {
  const PNG = Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000',
    'hex',
  );

  it('photo géolocalisée : envoi, rattachement au formulaire, accès et export', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    const otherLead = await t.createUser('team_lead');
    await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Relevé de vitrine',
          fields: [
            {
              key: 'commerce',
              label: 'Commerce',
              type: 'text',
              required: true,
            },
            { key: 'vitrine', label: 'Vitrine', type: 'photo', required: true },
          ],
        })
        .expect(201)
    ).body as { id: string };
    const mission = (
      await t.admin.api
        .post('/missions', {
          typeId: type.id,
          title: 'Vitrines du Plateau',
          zoneIds: [zone.id],
          progressMethod: 'count',
          targetValue: 10,
        })
        .expect(201)
    ).body as { id: string };
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);

    const upload = (
      actor: { api: Api },
      fields: Record<string, string>,
      buffer = PNG,
    ) => {
      const r = request(app.getHttpServer())
        .post('/api/photos')
        .set('Authorization', `Bearer ${actor.api.token}`)
        .attach('file', buffer, 'vitrine.png');
      for (const [k, v] of Object.entries(fields)) void r.field(k, v);
      return r;
    };
    const clientId = randomUUID();
    const takenAt = new Date().toISOString();
    const photo = (
      await upload(agent, {
        clientId,
        takenAt,
        lat: String(IN_PLATEAU.lat),
        lng: String(IN_PLATEAU.lng),
        accuracy: '8',
      }).expect(201)
    ).body as { id: string };
    // Renvoi (réseau coupé pendant la réponse) : même photo.
    const again = (await upload(agent, { clientId, takenAt }).expect(201))
      .body as { id: string };
    expect(again.id).toBe(photo.id);
    await upload(
      agent,
      { clientId: randomUUID(), takenAt },
      Buffer.from('texte'),
    )
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('PHOTO_FORMAT'));
    await upload(lead, { clientId: randomUUID(), takenAt }).expect(403);

    // Formulaire : photo obligatoire, valide, appartenant à l'agent.
    const submit = (data: object) =>
      agent.api.post(`/missions/${mission.id}/submissions`, {
        clientId: randomUUID(),
        data,
        submittedAt: new Date().toISOString(),
      });
    await submit({ commerce: 'Boutique A' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_FORM'));
    await submit({ commerce: 'Boutique A', vitrine: 'pas-un-id' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_FORM'));
    await submit({ commerce: 'Boutique A', vitrine: randomUUID() })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('PHOTO_MISSING'));
    await submit({ commerce: 'Boutique A', vitrine: photo.id }).expect(201);
    // Une photo ne sert qu'à un formulaire.
    await submit({ commerce: 'Boutique B', vitrine: photo.id })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('PHOTO_MISSING'));

    // Lecture : position et heure de prise avec le formulaire.
    const list = (
      await t.admin.api.get(`/missions/${mission.id}/submissions`).expect(200)
    ).body as {
      data: { vitrine: string };
      photos: Record<string, { lat: number; lng: number; accuracy: number }>;
    }[];
    expect(list[0].photos[photo.id]).toMatchObject({
      lat: IN_PLATEAU.lat,
      lng: IN_PLATEAU.lng,
      accuracy: 8,
    });

    // L'image : l'agent, son chef et l'administrateur ; pas les autres.
    for (const actor of [agent, lead, t.admin])
      await actor.api
        .get(`/photos/${photo.id}`)
        .expect(200)
        .expect('Content-Type', 'image/png');
    await other.api.get(`/photos/${photo.id}`).expect(404);
    await otherLead.api.get(`/photos/${photo.id}`).expect(403);

    // Export : heure de prise et position.
    const csv = await t.admin.api
      .get(`/exports/submissions?missionId=${mission.id}&format=csv`)
      .expect(200);
    expect(csv.text).toContain('Photo du ');
    expect(csv.text).toContain(IN_PLATEAU.lat.toFixed(5));
  });

  it('ma semaine : temps travaillé par jour, objectif, formulaires et semaine précédente', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent', { workdayMinutes: 420 });
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [{ key: 'nom', label: 'Nom', type: 'text', required: true }],
        })
        .expect(201)
    ).body as { id: string };
    const mission = (
      await t.admin.api
        .post('/missions', {
          typeId: type.id,
          title: 'Visites',
          zoneIds: [zone.id],
          progressMethod: 'count',
          targetValue: 10,
        })
        .expect(201)
    ).body as { id: string };

    // Lundi et mardi d'une semaine passée (6 h et 3 h), et une journée la semaine d'avant.
    const day = async (date: string, hours: number) => {
      const [{ id }] = await owner.query<{ id: string }[]>(
        `INSERT INTO work_days (tenant_id, agent_id, zone_id, status, work_date, started_at, ended_at)
         VALUES ($1, $2, $3, 'ended', $4::date, $4::date + time '08:00', $4::date + time '08:00' + $5 * interval '1 hour')
         RETURNING id`,
        [t.tenantId, agent.id, zone.id, date, hours],
      );
      return id;
    };
    const monday = await day('2026-09-07', 6);
    await day('2026-09-08', 3);
    await day('2026-09-01', 2);
    // Pause de 30 min le lundi.
    await owner.query(
      `INSERT INTO day_pauses (tenant_id, day_id, started_at, ended_at)
       VALUES ($1, $2, '2026-09-07 10:00', '2026-09-07 10:30')`,
      [t.tenantId, monday],
    );
    const formAt = async (at: string, status = 'accepted') =>
      owner.query(
        `INSERT INTO mission_submissions (tenant_id, mission_id, agent_id, client_id, data, submitted_at, status)
         VALUES ($1, $2, $3, gen_random_uuid(), '{"nom":"x"}', $4, $5)`,
        [t.tenantId, mission.id, agent.id, at, status],
      );
    await formAt('2026-09-07 11:00');
    await formAt('2026-09-07 12:00');
    await formAt('2026-09-08 11:00', 'rejected');

    const week = (await agent.api.get('/me/week?date=2026-09-09').expect(200))
      .body as {
      from: string;
      to: string;
      objectiveMinutes: number;
      days: {
        date: string;
        workedSeconds: number;
        zones: string[];
        forms: number;
        rejected: number;
      }[];
      totals: {
        workedSeconds: number;
        daysWorked: number;
        forms: number;
        rejected: number;
        objectiveSeconds: number;
      };
      previous: { workedSeconds: number; daysWorked: number };
      missions: { title: string; forms: number }[];
    };
    expect(week).toMatchObject({
      from: '2026-09-07',
      to: '2026-09-13',
      objectiveMinutes: 420,
    });
    expect(week.days).toHaveLength(7);
    expect(week.days[0]).toMatchObject({
      date: '2026-09-07',
      workedSeconds: 5.5 * 3600,
      zones: ['Plateau'],
      forms: 2,
      rejected: 0,
    });
    expect(week.days[1]).toMatchObject({
      workedSeconds: 3 * 3600,
      forms: 1,
      rejected: 1,
    });
    expect(week.days[2].workedSeconds).toBe(0);
    expect(week.totals).toEqual({
      workedSeconds: 8.5 * 3600,
      daysWorked: 2,
      forms: 3,
      rejected: 1,
      objectiveSeconds: 2 * 420 * 60,
    });
    expect(week.previous).toMatchObject({
      workedSeconds: 2 * 3600,
      daysWorked: 1,
    });
    expect(week.missions).toEqual([
      { id: mission.id, title: 'Visites', forms: 2 },
    ]);
    // Réservé à l'agent.
    await t.admin.api.get('/me/week').expect(403);
  });
});

describe('Alerte sécurité (SOS)', () => {
  it('déclenchée par l’agent, prise en charge, close ; jamais refermée seule', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const admin2 = await t.createUser('admin');
    const agent = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);

    const types = async (actor: { api: Api }) =>
      (
        (await actor.api.get('/notifications').expect(200)).body as {
          type: string;
        }[]
      ).map((n) => n.type);

    // Rien en cours.
    expect((await agent.api.get('/safety/sos').expect(200)).body).toEqual({});
    const raised = (
      await agent.api
        .post('/safety/sos', {
          lat: IN_PLATEAU.lat,
          lng: IN_PLATEAU.lng,
          accuracy: 12,
          battery: 0.4,
          message: 'Agression, besoin d’aide',
        })
        .expect(201)
    ).body as { id: string; type: string; data: Record<string, unknown> };
    expect(raised).toMatchObject({
      type: 'sos',
      data: {
        lat: IN_PLATEAU.lat,
        lng: IN_PLATEAU.lng,
        message: 'Agression, besoin d’aide',
      },
    });
    // Le chef et tous les administrateurs sont prévenus ; pas l'autre chef.
    for (const actor of [lead, t.admin, admin2])
      expect(await types(actor)).toContain('alert.sos');
    expect(await types(otherLead)).not.toContain('alert.sos');

    // Nouvelle position : même alerte, pas de nouvel envoi.
    const again = (
      await agent.api
        .post('/safety/sos', { lat: 5.321, lng: -4.021 })
        .expect(201)
    ).body as { id: string; data: { lat: number } };
    expect(again.id).toBe(raised.id);
    expect(again.data.lat).toBe(5.321);
    expect((await types(lead)).filter((x) => x === 'alert.sos')).toHaveLength(
      1,
    );
    expect((await agent.api.get('/safety/sos').expect(200)).body).toMatchObject(
      { id: raised.id },
    );

    // Prise en charge : l'agent sait que quelqu'un s'en occupe.
    await lead.api
      .post(`/alerts/${raised.id}/ack`, { note: 'J’appelle' })
      .expect(201);
    expect(await types(agent)).toContain('alert.sos_ack');

    // Fin de journée : l'alerte reste ouverte.
    await agent.api.post('/days/end').expect(200);
    const open = (await t.admin.api.get('/alerts?type=sos').expect(200))
      .body as {
      id: string;
      resolvedAt: string | null;
    }[];
    expect(open[0]).toMatchObject({ id: raised.id, resolvedAt: null });
    // Numéro de l'agent, pour l'appeler.
    expect(
      (open[0] as unknown as { agent: { phone: string } }).agent.phone,
    ).toMatch(/^\+225/);

    // Clôture : seulement par un responsable de l'agent, et seulement pour une alerte sécurité.
    await otherLead.api.post(`/alerts/${raised.id}/close`, {}).expect(403);
    const closed = (
      await lead.api
        .post(`/alerts/${raised.id}/close`, { note: 'Agent en sécurité' })
        .expect(201)
    ).body as { resolvedAt: string | null; data: { closingNote: string } };
    expect(closed.resolvedAt).not.toBeNull();
    expect(closed.data.closingNote).toBe('Agent en sécurité');
    expect(await types(agent)).toContain('alert.sos_closed');
    expect((await agent.api.get('/safety/sos').expect(200)).body).toEqual({});

    // Fausse alerte : annulée par l'agent, les responsables sont informés.
    const second = (await agent.api.post('/safety/sos', {}).expect(201))
      .body as {
      id: string;
    };
    expect(second.id).not.toBe(raised.id);
    await agent.api.post('/safety/sos/cancel').expect(204);
    expect(await types(lead)).toContain('alert.sos_cancelled');
    const cancelled = (
      (await t.admin.api.get('/alerts?type=sos&status=resolved').expect(200))
        .body as {
        id: string;
        data: { cancelled?: boolean };
      }[]
    ).find((a) => a.id === second.id);
    expect(cancelled?.data.cancelled).toBe(true);

    // Une alerte automatique ne se clôt pas à la main ; l'administrateur ne lance pas de SOS.
    const [{ id: auto }] = await owner.query<{ id: string }[]>(
      `INSERT INTO agent_alerts (tenant_id, agent_id, type, data) VALUES ($1, $2, 'low_battery', '{}') RETURNING id`,
      [t.tenantId, agent.id],
    );
    await t.admin.api
      .post(`/alerts/${auto}/close`, {})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('AUTO_RESOLVED'));
    await t.admin.api.post('/safety/sos', {}).expect(403);
  });
});

describe('Version minimale de l’app mobile', () => {
  it('app trop ancienne : 426 avec le lien de mise à jour ; web jamais bloqué', async () => {
    const versions = app.get(AppVersionService);
    const t = await newTenant(app);
    const agent = await t.createUser('agent');
    expect((await new Api(app).get('/app/version').expect(200)).body).toEqual({
      minVersion: null,
      latestVersion: null,
      androidUrl: null,
      iosUrl: null,
    });
    // Aucune version imposée : tout passe.
    await agent.api.get('/me/team').set('X-App-Version', '0.0.1').expect(200);

    await owner.query(
      `UPDATE platform_settings SET min_app_version = '1.2.0', latest_app_version = '1.3.0',
         android_store_url = 'https://exemple.ci/app.apk', ios_store_url = 'https://apps.apple.com/app/id1'`,
    );
    versions.invalidate();
    try {
      await agent.api
        .get('/me/team')
        .set('X-App-Version', '1.1.9')
        .expect(426)
        .expect((r) =>
          expect(r.body).toMatchObject({
            code: 'APP_UPDATE_REQUIRED',
            minVersion: '1.2.0',
            storeUrl: 'https://exemple.ci/app.apk',
          }),
        );
      await agent.api
        .get('/me/team')
        .set('X-App-Version', '1.1.9')
        .set('X-App-Platform', 'ios')
        .expect(426)
        .expect((r) =>
          expect(r.body.storeUrl).toBe('https://apps.apple.com/app/id1'),
        );
      // Ancienne app sans en-tête de version : reconnue à son agent HTTP.
      await agent.api
        .get('/me/team')
        .set('User-Agent', 'Dart/3.10 (dart:io)')
        .expect(426);
      // Connexion refusée aussi (avant même l'identification).
      await new Api(app)
        .post('/auth/login', { phone: '0700000000', password: 'x' })
        .set('X-App-Version', '1.0.0')
        .expect(426);
      // À jour, ou plus récente.
      await agent.api.get('/me/team').set('X-App-Version', '1.2.0').expect(200);
      await agent.api
        .get('/me/team')
        .set('X-App-Version', '1.10.0')
        .expect(200);
      // Le site web n'est jamais concerné, ni la santé et la version.
      await agent.api.get('/me/team').expect(200);
      await new Api(app)
        .get('/health')
        .set('X-App-Version', '1.0.0')
        .expect(200);
      await new Api(app)
        .get('/app/version')
        .set('X-App-Version', '1.0.0')
        .expect(200);
    } finally {
      await owner.query(
        `UPDATE platform_settings SET min_app_version = NULL, latest_app_version = NULL,
           android_store_url = NULL, ios_store_url = NULL`,
      );
      versions.invalidate();
    }
  });

  it('comparaison des versions', () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0+7', '1.2.1')).toBeLessThan(0);
  });
});

describe('Durée de travail', () => {
  it('structure, puis groupe, puis agent ; visible dans l’app, le bilan et l’historique', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const partial = await t.createUser('agent');
    const loner = await t.createUser('agent');
    const group = await t.createGroup(
      'Nord',
      lead.id,
      [agent.id, partial.id],
      [zone.id],
    );
    const workday = async (api: Api) =>
      (await api.get('/auth/me').expect(200)).body.workday as Body;

    // Par défaut : 8 h, fixées par la structure.
    expect(await workday(agent.api)).toEqual({
      minutes: 480,
      source: 'structure',
    });
    await t.admin.api.patch('/settings', { workdayMinutes: 20 }).expect(400);
    await t.admin.api.patch('/settings', { workdayMinutes: 420 }).expect(200);
    expect(await workday(loner.api)).toEqual({
      minutes: 420,
      source: 'structure',
    });

    // Le groupe, puis l'agent (temps partiel), l'emportent.
    await t.admin.api
      .patch(`/groups/${group.id}`, { workdayMinutes: 360 })
      .expect(200);
    await t.admin.api
      .patch(`/users/${partial.id}`, { workdayMinutes: 240 })
      .expect(200);
    expect(await workday(agent.api)).toEqual({ minutes: 360, source: 'group' });
    expect(await workday(partial.api)).toEqual({
      minutes: 240,
      source: 'agent',
    });
    expect(await workday(loner.api)).toEqual({
      minutes: 420,
      source: 'structure',
    });
    // Retour à la durée du niveau au-dessus.
    await t.admin.api
      .patch(`/users/${partial.id}`, { workdayMinutes: null })
      .expect(200);
    expect(await workday(partial.api)).toEqual({
      minutes: 360,
      source: 'group',
    });
    // Le profil des autres rôles ne porte pas de durée.
    expect(
      (await lead.api.get('/auth/me').expect(200)).body.workday,
    ).toBeUndefined();

    // Bilan du jour et historique : la durée attendue de chaque agent.
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    const report = (await t.admin.api.get('/reports/daily').expect(200)).body;
    const row = (report.agents as Body[]).find((r) => r.id === agent.id)!;
    expect(row.targetMinutes).toBe(360);
    expect(
      (report.agents as Body[]).find((r) => r.id === loner.id)!.targetMinutes,
    ).toBe(420);
    const history = (await t.admin.api.get('/days').expect(200)).body
      .items as Body[];
    expect(history[0]).toMatchObject({ agentId: agent.id, targetMinutes: 360 });

    // Création d'un agent à temps partiel.
    const created = await t.admin.api
      .post('/users', {
        email: uniqueEmail('mi-temps'),
        password: PASSWORD,
        firstName: 'Mi',
        lastName: 'Temps',
        role: 'agent',
        phone: uniquePhone(),
        workdayMinutes: 210,
      })
      .expect(201);
    expect(created.body.workdayMinutes).toBe(210);
  });
});

describe('Missions par zone', () => {
  it('zones obligatoires, missions ouvertes, choix de la zone, formulaires en journée', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const plateau = await t.createZone('Plateau', PLATEAU);
    const cocody = await t.createZone('Cocody', COCODY);
    const yopougon = await t.createZone('Yopougon', YOPOUGON);
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const orphan = await t.createUser('agent');
    const nord = await t.createGroup('Nord', lead.id, [agent.id], [plateau.id]);
    await t.createGroup('Sud', otherLead.id, [], [cocody.id]);
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [
            {
              key: 'nom',
              label: 'Nom du commerce',
              type: 'text',
              required: true,
            },
          ],
        })
        .expect(201)
    ).body as { id: string };
    const base = { typeId: type.id, progressMethod: 'count', targetValue: 10 };

    // Zones obligatoires, actives, et cohérentes avec l'affectation et le créateur.
    await t.admin.api
      .post('/missions', { ...base, title: 'Sans zone', zoneIds: [] })
      .expect(400);
    await t.admin.api
      .post('/missions', {
        ...base,
        title: 'Hors groupe',
        assigneeGroupId: nord.id,
        zoneIds: [cocody.id],
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('ZONE_OUTSIDE_GROUP'));
    await lead.api
      .post('/missions', { ...base, title: 'Chez Sud', zoneIds: [cocody.id] })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('ZONE_OUTSIDE_SCOPE'));

    // Mission ouverte au Plateau (créée par le chef) et à Yopougon (zone libre, admin).
    const plateauOpen = (
      await lead.api
        .post('/missions', {
          ...base,
          title: 'Prospection Plateau',
          description: 'Présentez la nouvelle offre.',
          zoneIds: [plateau.id],
        })
        .expect(201)
    ).body as Body;
    expect(plateauOpen).toMatchObject({
      assigneeAgentId: null,
      assigneeGroupId: null,
      zones: [{ id: plateau.id, name: 'Plateau' }],
    });
    const free = (
      await t.admin.api
        .post('/missions', {
          ...base,
          title: 'Yopougon libre',
          zoneIds: [yopougon.id],
        })
        .expect(201)
    ).body as Body;
    await t.admin.api
      .post('/missions', { ...base, title: 'Cocody Sud', zoneIds: [cocody.id] })
      .expect(201);

    // L'agent voit les missions ouvertes des zones qu'il peut choisir, jamais celles d'un autre groupe.
    const titles = async (api: Api, query = '') =>
      ((await api.get(`/missions${query}`).expect(200)).body.items as Body[])
        .map((m) => m.title)
        .sort();
    expect(await titles(agent.api)).toEqual([
      'Prospection Plateau',
      'Yopougon libre',
    ]);
    expect(await titles(orphan.api)).toEqual(['Yopougon libre']);
    expect(await titles(agent.api, `?zoneId=${yopougon.id}`)).toEqual([
      'Yopougon libre',
    ]);
    await orphan.api.get(`/missions/${plateauOpen.id}`).expect(404);
    expect(await titles(lead.api)).toEqual([
      'Prospection Plateau',
      'Yopougon libre',
    ]);

    // Choix de la zone : les missions de chaque zone, avec consignes et formulaire.
    const available = (await agent.api.get('/zones/available').expect(200)).body
      .zones as Body[];
    const plateauZone = available.find((z) => z.id === plateau.id)!;
    expect(plateauZone.missions).toEqual([
      expect.objectContaining({
        title: 'Prospection Plateau',
        description: 'Présentez la nouvelle offre.',
        assignment: 'open',
        fields: ['Nom du commerce'],
        myForms: 0,
        progress: { current: 0, target: 10, percent: 0 },
      }),
    ]);
    expect(plateauZone.missions[0]).toHaveProperty('myEarnings');

    // Formulaire : pendant une journée, dans une zone de la mission.
    const form = (lat?: number, lng?: number) => ({
      clientId: crypto.randomUUID(),
      data: { nom: 'Boutique' },
      submittedAt: new Date().toISOString(),
      ...(lat === undefined ? {} : { lat, lng }),
    });
    await agent.api
      .post(`/missions/${plateauOpen.id}/submissions`, form())
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DAY_REQUIRED'));
    await agent.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    await agent.api
      .post(`/missions/${free.id}/submissions`, form())
      .expect(409)
      .expect((r) => {
        expect(r.body.code).toBe('WRONG_ZONE');
        expect(r.body.message).toContain('Yopougon');
      });
    const inside = (
      await agent.api
        .post(
          `/missions/${plateauOpen.id}/submissions`,
          form(IN_PLATEAU.lat, IN_PLATEAU.lng),
        )
        .expect(201)
    ).body;
    expect(inside).toMatchObject({ zoneId: plateau.id, outOfZone: false });
    const outside = (
      await agent.api
        .post(
          `/missions/${plateauOpen.id}/submissions`,
          form(OUTSIDE.lat, OUTSIDE.lng),
        )
        .expect(201)
    ).body;
    expect(outside.outOfZone).toBe(true);
    const listed = (
      (await agent.api.get('/missions').expect(200)).body.items as Body[]
    ).find((m) => m.id === plateauOpen.id)!;
    expect(listed).toMatchObject({ myForms: 2 });

    // Réglage désactivé : hors journée accepté (et rattaché à aucune zone).
    await t.settings({ submissionRequiresDay: false });
    const loose = (
      await orphan.api
        .post(`/missions/${free.id}/submissions`, form())
        .expect(201)
    ).body;
    expect(loose).toMatchObject({ dayId: null, zoneId: null });

    // Zones modifiables, toujours au moins une.
    await lead.api
      .patch(`/missions/${plateauOpen.id}`, { zoneIds: [] })
      .expect(400);
    const moved = await t.admin.api
      .patch(`/missions/${plateauOpen.id}`, {
        zoneIds: [plateau.id, yopougon.id],
      })
      .expect(200);
    expect(moved.body.zones.map((z: Body) => z.name)).toEqual([
      'Plateau',
      'Yopougon',
    ]);
  });
});

describe('Échéance des missions', () => {
  it('refuse une échéance passée à la création et en modification, garde l’existante', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const agent = await t.createUser('agent');
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [{ key: 'nom', label: 'Nom', type: 'text', required: true }],
        })
        .expect(201)
    ).body as { id: string };
    const day = 86400_000;
    const body = (dueDate: string) => ({
      zoneIds: [zone.id],
      typeId: type.id,
      title: 'Visites',
      assigneeAgentId: agent.id,
      progressMethod: 'count',
      targetValue: 5,
      dueDate,
    });
    const past = new Date(Date.now() - 2 * day).toISOString();
    const res = await t.admin.api.post('/missions', body(past)).expect(400);
    expect((res.body as { code: string }).code).toBe('DUE_DATE_PAST');

    // Aujourd'hui reste permis, même à une heure déjà passée.
    const today = new Date();
    today.setUTCHours(0, 30, 0, 0);
    const mission = (
      await t.admin.api.post('/missions', body(today.toISOString())).expect(201)
    ).body as { id: string; dueDate: string };

    await t.admin.api
      .patch(`/missions/${mission.id}`, { dueDate: past })
      .expect(400);
    // Échéance dépassée : on peut modifier le reste sans la changer.
    await owner.query(
      `UPDATE missions SET due_date = now() - interval '3 days' WHERE id = $1`,
      [mission.id],
    );
    const [{ due_date }] = await owner.query<{ due_date: Date }[]>(
      `SELECT due_date FROM missions WHERE id = $1`,
      [mission.id],
    );
    const updated = await t.admin.api
      .patch(`/missions/${mission.id}`, {
        title: 'Visites (prolongée)',
        dueDate: due_date.toISOString(),
      })
      .expect(200);
    expect(updated.body).toMatchObject({ title: 'Visites (prolongée)' });
    const later = new Date(Date.now() + 5 * day).toISOString();
    await t.admin.api
      .patch(`/missions/${mission.id}`, { dueDate: later })
      .expect(200);
  });
});

describe('Mises à jour en direct des appareils', () => {
  it('annonce aux comptes de la structure ce que l’administrateur ou le chef modifie', async () => {
    const t = await newTenant(app);
    const agent = await t.createUser('agent');
    const other = await newTenant(app, 'Autre');
    const url = (await app.getUrl()).replace('[::1]', 'localhost');
    const connect = async (token?: string) => {
      const socket: Socket = io(url, {
        auth: { token },
        transports: ['websocket'],
      });
      await new Promise<void>((resolve, reject) => {
        socket.on('connect', () => resolve());
        socket.on('connect_error', reject);
      });
      return socket;
    };
    const agentSocket = await connect(agent.api.token);
    const outsider = await connect(other.admin.api.token);
    const seen: string[] = [];
    const foreign: string[] = [];
    agentSocket.on('sync', (e: { topic: string }) => seen.push(e.topic));
    outsider.on('sync', (e: { topic: string }) => foreign.push(e.topic));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const received = new Promise<{ topic: string }>((resolve) =>
        agentSocket.once('sync', resolve),
      );
      const zone = await t.createZone('Plateau', PLATEAU);
      expect(await received).toEqual({ topic: 'zones' });

      // Les gestes de l'agent lui-même ne sont pas annoncés ; les échecs non plus.
      await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
      await t.admin.api.patch('/zones/00000000-0000-0000-0000-000000000000', {
        name: 'X',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(seen).toEqual(['zones']);
      expect(foreign).toEqual([]);
    } finally {
      agentSocket.disconnect();
      outsider.disconnect();
    }
  });
});

describe('Réaffectation par un responsable (RG-31, RG-32)', () => {
  it('le chef déplace un agent en cours de journée ; seul l’administrateur force la capacité', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const plateau = await t.createZone('Plateau', PLATEAU);
    const cocody = await t.createZone('Cocody', COCODY, { capacity: 1 });
    const marcory = await t.createZone('Marcory', MARCORY);
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const blocker = await t.createUser('agent');
    const outsider = await t.createUser('agent');
    await t.createGroup(
      'Nord',
      lead.id,
      [agent.id, blocker.id],
      [plateau.id, cocody.id],
    );
    await t.createGroup('Sud', otherLead.id, [outsider.id], [marcory.id]);

    await agent.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;

    await lead.api
      .post('/zone-requests/reassign', {
        agentId: outsider.id,
        zoneId: plateau.id,
      })
      .expect(403);
    await lead.api
      .post('/zone-requests/reassign', {
        agentId: agent.id,
        zoneId: marcory.id,
      })
      .expect(403);

    await blocker.api.post('/zone-requests', { zoneId: cocody.id }).expect(201);
    await lead.api
      .post('/zone-requests/reassign', { agentId: agent.id, zoneId: cocody.id })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ZONE_FULL'));
    await lead.api
      .post('/zone-requests/reassign', {
        agentId: agent.id,
        zoneId: cocody.id,
        force: true,
      })
      .expect(403);

    const forced = await t.admin.api
      .post('/zone-requests/reassign', {
        agentId: agent.id,
        zoneId: cocody.id,
        force: true,
      })
      .expect(201);
    expect(forced.body).toMatchObject({
      status: 'approved',
      decisionReason: 'reassigned_over_capacity',
    });
    expect(
      (await t.admin.api.get(`/days/${day.id}`).expect(200)).body.zoneId,
    ).toBe(cocody.id);
    expect(
      (await agent.api.get('/notifications').expect(200)).body[0].type,
    ).toBe('zone_request.reassigned');

    const back = await lead.api
      .post('/zone-requests/reassign', {
        agentId: agent.id,
        zoneId: plateau.id,
      })
      .expect(201);
    expect(back.body.decidedById).toBe(lead.id);
    expect(
      (await t.admin.api.get(`/zones/${cocody.id}`).expect(200)).body.taken,
    ).toBe(1);
  });
});

describe('Missions (RG-13, RG-14, RG-35 à RG-39)', () => {
  const fields = [
    { key: 'commerce', label: 'Nom du commerce', type: 'text', required: true },
    { key: 'montant', label: 'Montant', type: 'number', required: false },
    {
      key: 'categorie',
      label: 'Catégorie',
      type: 'select',
      required: false,
      options: ['Boutique', 'Pharmacie'],
    },
  ];
  const submission = (data: object, extra: object = {}) => ({
    clientId: crypto.randomUUID(),
    data,
    submittedAt: new Date().toISOString(),
    ...extra,
  });

  it('crée des types de missions et valide leurs champs', async () => {
    const t = await newTenant(app);
    await t.admin.api
      .post('/mission-types', {
        name: 'X',
        fields: [{ key: 'c', label: 'C', type: 'select', required: true }],
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('MISSING_OPTIONS'));
    await t.admin.api
      .post('/mission-types', { name: 'X', fields: [fields[0], fields[0]] })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('DUPLICATE_FIELD'));
    await t.admin.api
      .post('/mission-types', {
        name: 'X',
        fields: [
          { key: 'Mauvaise Clé', label: 'x', type: 'text', required: true },
        ],
      })
      .expect(400);
    const agent = await t.createUser('agent');
    await agent.api.post('/mission-types', { name: 'X', fields }).expect(403);

    const type = await t.admin.api
      .post('/mission-types', { name: 'Prospection', fields })
      .expect(201);
    expect(type.body.fields).toHaveLength(3);
    await t.admin.api
      .patch(`/mission-types/${type.body.id}`, { isActive: false })
      .expect(200);
    expect(
      (await agent.api.get('/mission-types').expect(200)).body,
    ).toHaveLength(0);
  });

  it('suit la progression par comptage, rejet et idempotence', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const type = (
      await t.admin.api
        .post('/mission-types', { name: 'Prospection', fields })
        .expect(201)
    ).body;
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');

    await t.admin.api
      .post('/missions', {
        zoneIds: [zone.id],
        typeId: type.id,
        title: 'Sans objectif',
        assigneeAgentId: agent.id,
        progressMethod: 'count',
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('TARGET_REQUIRED'));
    await t.admin.api
      .post('/missions', {
        zoneIds: [zone.id],
        typeId: type.id,
        title: 'Double',
        assigneeAgentId: agent.id,
        assigneeGroupId: crypto.randomUUID(),
        progressMethod: 'count',
        targetValue: 2,
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_ASSIGNEE'));

    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: '2 visites',
          assigneeAgentId: agent.id,
          progressMethod: 'count',
          targetValue: 2,
        })
        .expect(201)
    ).body;
    expect(mission).toMatchObject({
      status: 'todo',
      progress: { current: 0, target: 2, percent: 0 },
    });
    expect(
      (await agent.api.get('/notifications').expect(200)).body[0].type,
    ).toBe('mission.assigned');

    expect(
      (await agent.api.get('/missions').expect(200)).body.items,
    ).toHaveLength(1);
    expect(
      (await other.api.get('/missions').expect(200)).body.items,
    ).toHaveLength(0);
    await other.api.get(`/missions/${mission.id}`).expect(404);
    await other.api
      .post(
        `/missions/${mission.id}/submissions`,
        submission({ commerce: 'X' }),
      )
      .expect(404);

    await agent.api
      .post(`/missions/${mission.id}/submissions`, submission({}))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_FORM'));
    await agent.api
      .post(
        `/missions/${mission.id}/submissions`,
        submission({ commerce: 'X', categorie: 'Garage' }),
      )
      .expect(400);
    await agent.api
      .post(
        `/missions/${mission.id}/submissions`,
        submission({ commerce: 'X', montant: 'cent' }),
      )
      .expect(400);

    const first = submission({
      commerce: 'Boutique Awa',
      categorie: 'Boutique',
      inconnu: 'ignoré',
    });
    const created = await agent.api
      .post(`/missions/${mission.id}/submissions`, first)
      .expect(201);
    expect(created.body.data).toEqual({
      commerce: 'Boutique Awa',
      categorie: 'Boutique',
    });
    // Renvoi du même formulaire (synchronisation hors ligne) : pas de doublon.
    const resent = await agent.api
      .post(`/missions/${mission.id}/submissions`, first)
      .expect(201);
    expect(resent.body.id).toBe(created.body.id);
    expect(
      (await agent.api.get(`/missions/${mission.id}`).expect(200)).body,
    ).toMatchObject({
      status: 'in_progress',
      progress: { current: 1, percent: 50 },
    });

    const second = await agent.api
      .post(
        `/missions/${mission.id}/submissions`,
        submission({ commerce: 'Pharmacie du Port' }),
      )
      .expect(201);
    expect(
      (await agent.api.get(`/missions/${mission.id}`).expect(200)).body,
    ).toMatchObject({
      status: 'achieved',
      progress: { current: 2, percent: 100 },
    });

    // RG-39 : un formulaire rejeté ne compte plus.
    await agent.api
      .post(`/submissions/${second.body.id}/reject`, { reason: 'Doublon' })
      .expect(403);
    await t.admin.api
      .post(`/submissions/${second.body.id}/reject`, { reason: 'Photo floue' })
      .expect(200);
    expect(
      (await agent.api.get(`/missions/${mission.id}`).expect(200)).body.status,
    ).toBe('in_progress');
    expect(
      (await agent.api.get('/notifications').expect(200)).body[0].type,
    ).toBe('submission.rejected');
    expect(
      (await agent.api.get(`/missions/${mission.id}/submissions`).expect(200))
        .body,
    ).toHaveLength(2);
  });

  it('additionne un champ, valide manuellement et détaille les contributions du groupe', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const type = (
      await t.admin.api
        .post('/mission-types', { name: 'Collecte', fields })
        .expect(201)
    ).body;
    const lead = await t.createUser('team_lead');
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [a1.id, a2.id], []);

    await lead.api
      .post('/missions', {
        zoneIds: [zone.id],
        typeId: type.id,
        title: 'Collecte',
        assigneeGroupId: group.id,
        progressMethod: 'field_sum',
        sumFieldKey: 'commerce',
        targetValue: 1000,
      })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_SUM_FIELD'));

    const collect = (
      await lead.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: '1 000 FCFA collectés',
          assigneeGroupId: group.id,
          progressMethod: 'field_sum',
          sumFieldKey: 'montant',
          targetValue: 1000,
        })
        .expect(201)
    ).body;
    await a1.api
      .post(
        `/missions/${collect.id}/submissions`,
        submission({ commerce: 'A', montant: 600 }),
      )
      .expect(201);
    await a2.api
      .post(
        `/missions/${collect.id}/submissions`,
        submission({ commerce: 'B', montant: 150 }),
      )
      .expect(201);
    await a1.api
      .post(
        `/missions/${collect.id}/submissions`,
        submission({ commerce: 'C', montant: 300 }),
      )
      .expect(201);

    const detail = (await lead.api.get(`/missions/${collect.id}`).expect(200))
      .body;
    expect(detail).toMatchObject({
      status: 'achieved',
      progress: { current: 1050, target: 1000, percent: 100 },
    });
    expect(detail.contributions.map((c: Body) => [c.agentId, c.value])).toEqual(
      [
        [a1.id, 900],
        [a2.id, 150],
      ],
    );

    // L'agent ne voit que sa propre contribution, pas celles de ses collègues.
    const seenByA2 = (await a2.api.get(`/missions/${collect.id}`).expect(200))
      .body;
    expect(seenByA2.contributions).toEqual([]);
    expect(seenByA2.myContribution).toBe(150);
    expect(seenByA2.progress).toMatchObject({ current: 1050, target: 1000 });

    // Filtres des formulaires reçus : agent, statut, période.
    const received = async (query = '') =>
      (
        await lead.api
          .get(`/missions/${collect.id}/submissions${query}`)
          .expect(200)
      ).body as Body[];
    const commerces = (list: Body[]) =>
      list.map((s) => (s.data as Body).commerce).sort();
    expect(commerces(await received())).toEqual(['A', 'B', 'C']);
    const ofA1 = await received(`?agentId=${a1.id}`);
    expect(commerces(ofA1)).toEqual(['A', 'C']);
    // Un agent ne voit que les siens, même en demandant ceux d'un collègue.
    const own = (
      await a2.api
        .get(`/missions/${collect.id}/submissions?agentId=${a1.id}`)
        .expect(200)
    ).body as Body[];
    expect(commerces(own)).toEqual(['B']);

    const c = ofA1.find((s) => (s.data as Body).commerce === 'C')!;
    await lead.api
      .post(`/submissions/${c.id}/reject`, { reason: 'Doublon' })
      .expect(200);
    expect(commerces(await received('?status=rejected'))).toEqual(['C']);
    expect(commerces(await received('?status=accepted'))).toEqual(['A', 'B']);
    expect(
      commerces(await received(`?agentId=${a1.id}&status=accepted`)),
    ).toEqual(['A']);

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const inAnHour = new Date(Date.now() + 3600_000).toISOString();
    expect(await received(`?from=${hourAgo}`)).toHaveLength(3);
    expect(await received(`?from=${inAnHour}`)).toHaveLength(0);
    expect(await received(`?to=${hourAgo}`)).toHaveLength(0);
    await lead.api
      .get(`/missions/${collect.id}/submissions?status=valide`)
      .expect(400);

    const manual = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: 'Audit du point de vente',
          assigneeAgentId: a1.id,
          progressMethod: 'manual',
        })
        .expect(201)
    ).body;
    expect(manual.progress).toEqual({ current: 0, target: 1, percent: 0 });
    await t.admin.api
      .post(`/missions/${collect.id}/result`, { achieved: true })
      .expect(400);
    const done = await lead.api
      .post(`/missions/${manual.id}/result`, { achieved: true })
      .expect(200);
    expect(done.body).toMatchObject({
      status: 'achieved',
      progress: { percent: 100 },
    });
  });

  it('passe en échec à l’échéance et refuse les saisies tardives', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const type = (
      await t.admin.api
        .post('/mission-types', { name: 'P', fields })
        .expect(201)
    ).body;
    const agent = await t.createUser('agent');
    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: 'Urgent',
          assigneeAgentId: agent.id,
          progressMethod: 'count',
          targetValue: 5,
          dueDate: new Date(Date.now() + 3600_000).toISOString(),
        })
        .expect(201)
    ).body;
    await owner.query(
      `UPDATE missions SET due_date = now() - interval '1 minute' WHERE id = $1`,
      [mission.id],
    );
    await jobs.overdueMissions();
    expect(
      (await agent.api.get(`/missions/${mission.id}`).expect(200)).body.status,
    ).toBe('failed');
    await agent.api
      .post(
        `/missions/${mission.id}/submissions`,
        submission({ commerce: 'X' }),
      )
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('MISSION_CLOSED'));

    await t.admin.api
      .patch(`/missions/${mission.id}`, { title: 'Renommée' })
      .expect(200);
    await t.admin.api.delete(`/missions/${mission.id}`).expect(204);
    await agent.api.get(`/missions/${mission.id}`).expect(404);
  });
});

describe('Remise à zéro quotidienne (RG-22)', () => {
  it('termine les journées ouvertes et libère toutes les places, une seule fois', async () => {
    const t = await newTenant(app);
    await t.settings({ approvalMode: 'mixed' });
    const zone = await t.createZone('Plateau', PLATEAU);
    const sensitive = await t.createZone('Sensible', COCODY, {
      sensitive: true,
    });
    const working = await t.createUser('agent');
    const waiting = await t.createUser('agent');
    await working.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await working.api.post('/days/start').expect(200)).body;
    await waiting.api
      .post('/zone-requests', { zoneId: sensitive.id })
      .expect(201);

    await owner.query(
      `UPDATE tenant_settings SET last_reset_date = current_date - 1 WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.everyMinute();

    expect(
      (await t.admin.api.get(`/days/${day.id}`).expect(200)).body,
    ).toMatchObject({
      status: 'ended',
      endReason: 'auto_reset',
    });
    expect(
      (await t.admin.api.get(`/zones/${zone.id}`).expect(200)).body.taken,
    ).toBe(0);
    expect(
      (await t.admin.api.get(`/zones/${sensitive.id}`).expect(200)).body.taken,
    ).toBe(0);
    const requests = (await t.admin.api.get('/zone-requests').expect(200)).body
      .items;
    expect(requests.map((r: Body) => r.releaseReason).sort()).toEqual([
      'daily_reset',
      'day_ended',
    ]);

    // Deuxième passage le même jour : rien ne change.
    await working.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await jobs.everyMinute();
    expect(
      (await working.api.get('/days/current').expect(200)).body.approved,
    ).not.toBeNull();
  });
});

describe('Facturation, notifications et journal des accès', () => {
  it('compte les agents actifs du mois (RG-40)', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const active = await t.createUser('agent');
    await t.createUser('agent'); // compte jamais utilisé : non facturé
    await active.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await active.api.post('/days/start').expect(200);
    await active.api.post('/days/end').expect(200);
    await active.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await active.api.post('/days/start').expect(200);

    const billing = await t.admin.api.get('/billing/active-agents').expect(200);
    expect(billing.body).toMatchObject({
      activeAgents: 1,
      agents: [{ id: active.id, days: 2 }],
    });
    await t.admin.api.get('/billing/active-agents?month=2026-13').expect(400);
    await active.api.get('/billing/active-agents').expect(403);

    // Informations utiles par agent.
    const row = billing.body.agents[0];
    expect(row).toMatchObject({
      phone: expect.stringMatching(/^\+225/),
      isActive: true,
      mainZone: 'Plateau',
      zones: 1,
      forms: 0,
      autoClosedDays: 0,
    });
    expect(row.firstDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.workedSeconds).toBeGreaterThanOrEqual(0);
    expect(billing.body.previous.activeAgents).toBe(0);
    expect(billing.body.shown).toMatchObject({ agents: 1, days: 2 });

    // Filtres : la liste change, le total facturé du mois non.
    const list = async (q: string) =>
      (await t.admin.api.get(`/billing/active-agents?${q}`).expect(200))
        .body as Body;
    const filtered = await list('minDays=3');
    expect(filtered.agents).toHaveLength(0);
    expect(filtered.activeAgents).toBe(1);
    expect((await list(`search=${row.lastName}`)).agents).toHaveLength(1);
    expect((await list('search=introuvable')).agents).toHaveLength(0);
    expect(
      (await list(`search=${(row.phone as string).slice(-6)}`)).agents,
    ).toHaveLength(1);
    expect((await list(`zoneId=${zone.id}`)).agents).toHaveLength(1);
    expect((await list(`groupId=${crypto.randomUUID()}`)).agents).toHaveLength(
      0,
    );
    expect((await list('account=inactive')).agents).toHaveLength(0);
    await t.admin.api
      .patch(`/users/${active.id}`, { isActive: false })
      .expect(200);
    const inactive = await list('account=inactive');
    expect(inactive.agents).toHaveLength(1);
    expect(inactive.agents[0].isActive).toBe(false);
    await t.admin.api.get('/billing/active-agents?minDays=0').expect(400);
    await t.admin.api.get('/billing/active-agents?account=parti').expect(400);
  });

  it('marque les notifications comme lues', async () => {
    const t = await newTenant(app);
    await t.settings({ approvalMode: 'manual' });
    const zone = await t.createZone('Plateau', PLATEAU);
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');
    await a1.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await a2.api.post('/zone-requests', { zoneId: zone.id }).expect(201);

    const unread = (
      await t.admin.api.get('/notifications?unreadOnly=true').expect(200)
    ).body;
    expect(unread).toHaveLength(2);
    await t.admin.api.post(`/notifications/${unread[0].id}/read`).expect(204);
    expect(
      (await t.admin.api.get('/notifications?unreadOnly=true').expect(200))
        .body,
    ).toHaveLength(1);
    await t.admin.api.post('/notifications/read-all').expect(204);
    expect(
      (await t.admin.api.get('/notifications?unreadOnly=true').expect(200))
        .body,
    ).toHaveLength(0);
    // Un utilisateur ne peut pas lire les notifications d'un autre.
    await a1.api.post(`/notifications/${unread[1].id}/read`).expect(404);
  });

  it('journalise les connexions et les modifications', async () => {
    const t = await newTenant(app);
    await t.createZone('Plateau', PLATEAU);
    await new Api(app)
      .post('/auth/login', { email: t.admin.email, password: 'faux' })
      .expect(401);
    await login(app, t.admin.email);
    // L'écriture du journal se fait après la réponse.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logs = (await t.admin.api.get('/audit-logs').expect(200)).body;
    const actions = logs.items.map((l: Body) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.register',
        'auth.login',
        'auth.login_failed',
        'ZonesController.create',
      ]),
    );
    const agent = await t.createUser('agent');
    await agent.api.get('/audit-logs').expect(403);
  });
});

describe('Désactivation et suppression définitive en cascade', () => {
  const missionFields = [
    { key: 'commerce', label: 'Commerce', type: 'text', required: true },
  ];

  it('groupe : désactivation réversible, puis suppression confirmée', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    const type = (
      await t.admin.api
        .post('/mission-types', { name: 'P', fields: missionFields })
        .expect(201)
    ).body;
    await t.admin.api
      .post('/missions', {
        zoneIds: [zone.id],
        typeId: type.id,
        title: 'M',
        assigneeGroupId: group.id,
        progressMethod: 'count',
        targetValue: 5,
      })
      .expect(201);

    const impact = await t.admin.api
      .get(`/groups/${group.id}/impact`)
      .expect(200);
    expect(impact.body).toEqual({
      impact: { agents: 1, missions: 1, zones: 1 },
      requiresForce: true,
    });
    await t.admin.api
      .delete(`/groups/${group.id}`)
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'HAS_DEPENDENCIES',
          impact: { missions: 1 },
        }),
      );

    // Désactivation : le groupe disparaît des listes, son chef perd ses droits ; ses zones
    // redeviennent libres (ouvertes aux agents sans groupe actif).
    await t.admin.api
      .patch(`/groups/${group.id}`, { isActive: false })
      .expect(200);
    expect((await t.admin.api.get('/groups').expect(200)).body).toHaveLength(0);
    expect(
      (await t.admin.api.get('/groups?includeInactive=true').expect(200))
        .body[0].isActive,
    ).toBe(false);
    expect(
      (await agent.api.get('/zones/available').expect(200)).body.zones.map(
        (z: Body) => z.id,
      ),
    ).toEqual([zone.id]);
    expect((await lead.api.get('/users').expect(200)).body.items).toHaveLength(
      0,
    );

    await t.admin.api
      .patch(`/groups/${group.id}`, { isActive: true })
      .expect(200);
    expect(
      (await agent.api.get('/zones/available').expect(200)).body.zones,
    ).toHaveLength(1);

    await t.admin.api.delete(`/groups/${group.id}?force=true`).expect(204);
    expect((await t.admin.api.get('/missions').expect(200)).body.total).toBe(0);
    expect(
      (await t.admin.api.get(`/users/${agent.id}`).expect(200)).body.groupId,
    ).toBeNull();
  });

  it('zone : fermeture, réouverture contrôlée, suppression de l’historique', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    const agent = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);

    // Sans historique, la suppression ne demande pas de confirmation.
    const empty = await t.createZone('Vide', COCODY);
    expect(
      (await t.admin.api.get(`/zones/${empty.id}/impact`).expect(200)).body
        .requiresForce,
    ).toBe(false);
    await t.admin.api.delete(`/zones/${empty.id}`).expect(204);

    await t.admin.api.delete(`/zones/${zone.id}`).expect(409);
    await t.admin.api
      .patch(`/zones/${zone.id}`, { isActive: false })
      .expect(200);
    expect(
      (await agent.api.get('/days/current').expect(200)).body.approved,
    ).toBeNull();

    // Une zone qui chevauche la zone fermée peut être créée ; la réouverture est alors refusée.
    const other = await t.createZone('Remplaçante', PLATEAU);
    await t.admin.api
      .patch(`/zones/${zone.id}`, { isActive: true })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('ZONE_OVERLAP'));
    await t.admin.api.delete(`/zones/${other.id}`).expect(204);
    await t.admin.api
      .patch(`/zones/${zone.id}`, { isActive: true })
      .expect(200);

    await t.admin.api.delete(`/zones/${zone.id}?force=true`).expect(204);
    expect(
      (await t.admin.api.get('/zones?includeInactive=true').expect(200)).body,
    ).toHaveLength(0);
    expect(
      (await t.admin.api.get(`/zone-requests?agentId=${agent.id}`).expect(200))
        .body.total,
    ).toBe(0);
  });

  it('utilisateur : désactivation qui libère la place, suppression en cascade protégée', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 1 });
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;
    await agent.api
      .post('/positions/batch', { dayId: day.id, points: [point(new Date())] })
      .expect(200);
    await agent.api.post('/days/end').expect(200);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);

    await t.admin.api
      .patch(`/users/${agent.id}`, { isActive: false })
      .expect(200);
    await other.api.post('/zone-requests', { zoneId: zone.id }).expect(201);

    expect(
      (await t.admin.api.get(`/users/${agent.id}/impact`).expect(200)).body
        .impact,
    ).toMatchObject({
      days: 1,
      positions: 1,
    });
    await t.admin.api.delete(`/users/${agent.id}`).expect(409);
    await t.admin.api.delete(`/users/${t.admin.id}?force=true`).expect(403);
    await t.admin.api.delete(`/users/${agent.id}?force=true`).expect(204);
    await t.admin.api.get(`/users/${agent.id}`).expect(404);
    expect((await t.admin.api.get('/days').expect(200)).body.total).toBe(0);

    // Le dernier administrateur ne peut pas être supprimé, même par un autre administrateur.
    const admin2 = await t.createUser('admin');
    await t.admin.api
      .patch(`/users/${admin2.id}`, { isActive: false })
      .expect(200);
    await admin2.api.get('/users').expect(401);
  });

  it('mission et type de mission : désactivation, puis suppression des formulaires', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const agent = await t.createUser('agent');
    const type = (
      await t.admin.api
        .post('/mission-types', { name: 'P', fields: missionFields })
        .expect(201)
    ).body;
    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: 'M',
          assigneeAgentId: agent.id,
          progressMethod: 'count',
          targetValue: 5,
        })
        .expect(201)
    ).body;
    const submission = () => ({
      clientId: crypto.randomUUID(),
      data: { commerce: 'X' },
      submittedAt: new Date().toISOString(),
    });
    await agent.api
      .post(`/missions/${mission.id}/submissions`, submission())
      .expect(201);

    await t.admin.api.delete(`/missions/${mission.id}`).expect(409);
    await t.admin.api
      .patch(`/missions/${mission.id}`, { isActive: false })
      .expect(200);
    expect(
      (await agent.api.get('/missions').expect(200)).body.items,
    ).toHaveLength(0);
    // Désactivée : l'agent apprend qu'elle est close (lecture et envoi).
    await agent.api
      .get(`/missions/${mission.id}`)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('MISSION_CLOSED'));
    await agent.api
      .post(`/missions/${mission.id}/submissions`, {
        clientId: crypto.randomUUID(),
        data: { commerce: 'Après clôture' },
        submittedAt: new Date().toISOString(),
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('MISSION_CLOSED'));
    expect(
      (await t.admin.api.get('/missions').expect(200)).body.items,
    ).toHaveLength(0);
    expect(
      (await t.admin.api.get('/missions?includeInactive=true').expect(200)).body
        .items,
    ).toHaveLength(1);
    await t.admin.api
      .patch(`/missions/${mission.id}`, { isActive: true })
      .expect(200);
    await agent.api
      .post(`/missions/${mission.id}/submissions`, submission())
      .expect(201);

    expect(
      (await t.admin.api.get(`/mission-types/${type.id}/impact`).expect(200))
        .body.impact,
    ).toEqual({ missions: 1 });
    await t.admin.api.delete(`/mission-types/${type.id}`).expect(409);
    await t.admin.api
      .delete(`/mission-types/${type.id}?force=true`)
      .expect(204);
    await t.admin.api.get(`/missions/${mission.id}`).expect(404);
  });
});

describe("Personnalisation de l'app mobile", () => {
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  it("l'agent reçoit la personnalisation de sa structure ; seul l'administrateur la modifie", async () => {
    const t = await newTenant(app, 'Marque');
    const agent = await t.createUser('agent');

    const initial = await agent.api.get('/branding').expect(200);
    expect(initial.body).toMatchObject({
      displayName: 'Marque',
      primaryColor: '#2563EB',
      onPrimaryColor: '#FFFFFF',
      logoUrl: null,
      version: 1,
    });

    await agent.api.patch('/branding', { primaryColor: '#000000' }).expect(403);
    await t.admin.api.patch('/branding', { primaryColor: 'rouge' }).expect(400);
    await t.admin.api.patch('/branding', { supportPhone: 'abc' }).expect(400);

    const updated = await t.admin.api
      .patch('/branding', {
        displayName: 'Ma Marque',
        primaryColor: '#fde047',
        welcomeMessage: 'Bienvenue',
        supportPhone: '+225 01 02 03 04 05',
      })
      .expect(200);
    // Couleur claire : le texte des boutons devient foncé pour rester lisible.
    expect(updated.body).toMatchObject({
      displayName: 'Ma Marque',
      primaryColor: '#FDE047',
      onPrimaryColor: '#0F172A',
      version: 2,
    });
    expect(
      (await agent.api.get('/branding').expect(200)).body.welcomeMessage,
    ).toBe('Bienvenue');

    // Une valeur vide rétablit le nom de la structure.
    expect(
      (await t.admin.api.patch('/branding', { displayName: '' }).expect(200))
        .body.displayName,
    ).toBe('Marque');

    // Isolation : une autre structure garde ses propres couleurs.
    const other = await newTenant(app, 'Autre');
    expect(
      (await other.admin.api.get('/branding').expect(200)).body.primaryColor,
    ).toBe('#2563EB');
    await new Api(app).get('/branding').expect(401);
  });

  it('gère le logo : format vérifié, taille limitée, accès authentifié', async () => {
    const t = await newTenant(app, 'Logo');
    const agent = await t.createUser('agent');
    const upload = (buffer: Buffer, name: string) =>
      request(app.getHttpServer())
        .put('/api/branding/logo')
        .set('Authorization', `Bearer ${t.admin.api.token}`)
        .attach('file', buffer, name);

    await upload(Buffer.from('ceci nest pas une image'), 'logo.png')
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('LOGO_FORMAT'));
    await upload(Buffer.concat([PNG, Buffer.alloc(600 * 1024)]), 'gros.png')
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('LOGO_TOO_LARGE'));

    const res = await upload(PNG, 'logo.png').expect(200);
    expect(res.body.logoUrl).toBe(`/api/branding/logo?v=${res.body.version}`);

    const logo = await agent.api.get('/branding/logo').expect(200);
    expect(logo.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(logo.body as Buffer, PNG)).toBe(0);
    await new Api(app).get('/branding/logo').expect(401);

    await t.admin.api.delete('/branding/logo').expect(200);
    await agent.api.get('/branding/logo').expect(404);
  });
});

describe('Connexion par téléphone (app mobile)', () => {
  it('connecte avec le numéro, quel que soit son format de saisie', async () => {
    const t = await newTenant(app);
    const created = await t.admin.api
      .post('/users', {
        email: uniqueEmail('tel'),
        password: PASSWORD,
        firstName: 'Ama',
        lastName: 'Tel',
        role: 'agent',
        phone: '07 55 44 33 22',
      })
      .expect(201);
    expect(created.body.phone).toBe('+2250755443322');

    for (const phone of [
      '0755443322',
      '+225 07 55 44 33 22',
      '00225-07.55.44.33.22',
    ]) {
      await new Api(app)
        .post('/auth/login', { phone, password: PASSWORD })
        .expect(200);
    }
    await new Api(app)
      .post('/auth/login', { phone: '0755443322', password: 'faux' })
      .expect(401)
      .expect((r) => expect(r.body.code).toBe('INVALID_CREDENTIALS'));
    await new Api(app)
      .post('/auth/login', { phone: '0700000000', password: PASSWORD })
      .expect(401);
    await new Api(app).post('/auth/login', { password: PASSWORD }).expect(400);
  });

  it('exige un numéro unique pour les agents et les chefs d’équipe', async () => {
    const t = await newTenant(app);
    const body = (extra: object) => ({
      email: uniqueEmail('x'),
      password: PASSWORD,
      firstName: 'A',
      lastName: 'B',
      ...extra,
    });

    await t.admin.api
      .post('/users', body({ role: 'agent' }))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('PHONE_REQUIRED'));
    await t.admin.api
      .post('/users', body({ role: 'team_lead', phone: 'abc' }))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('INVALID_PHONE'));
    // Les administrateurs (plateforme web) peuvent ne pas en avoir.
    await t.admin.api.post('/users', body({ role: 'admin' })).expect(201);

    const phone = uniquePhone();
    const lead = await t.admin.api
      .post('/users', body({ role: 'team_lead', phone }))
      .expect(201);
    // Unicité sur toute la plateforme, même saisi autrement et dans une autre structure.
    const other = await newTenant(app);
    await other.admin.api
      .post(
        '/users',
        body({ role: 'agent', phone: `+225${phone.replace(/\s/g, '')}` }),
      )
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PHONE_TAKEN'));

    await t.admin.api
      .patch(`/users/${lead.body.id}`, { phone: null })
      .expect(400);
    await t.admin.api
      .patch(`/users/${lead.body.id}`, { firstName: 'Renommé' })
      .expect(200);
  });
});

describe("Chefs d'équipe vus par l'administrateur", () => {
  it('mesure la réactivité et retrace les actions de chaque chef', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true, approvalMode: 'manual' });
    const plateau = await t.createZone('Plateau', PLATEAU, { capacity: 3 });
    const cocody = await t.createZone('Cocody', COCODY, { capacity: 3 });
    const lead = await t.createUser('team_lead');
    const idle = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    await t.createGroup(
      'Nord',
      lead.id,
      [agent.id, other.id],
      [plateau.id, cocody.id],
    );

    // Le chef refuse une demande, en valide une autre, puis change l'agent de zone.
    const first = await agent.api
      .post('/zone-requests', { zoneId: cocody.id })
      .expect(201);
    await lead.api
      .post(`/zone-requests/${first.body.id}/decision`, {
        approve: false,
        reason: 'Zone déjà couverte',
      })
      .expect(201);
    const second = await agent.api
      .post('/zone-requests', { zoneId: plateau.id })
      .expect(201);
    await lead.api
      .post(`/zone-requests/${second.body.id}/decision`, { approve: true })
      .expect(201);
    await lead.api
      .post('/zone-requests/reassign', { agentId: agent.id, zoneId: cocody.id })
      .expect(201);
    // Une demande reste en attente.
    await other.api.post('/zone-requests', { zoneId: plateau.id }).expect(201);

    // Il crée une mission et rejette un formulaire.
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [
            {
              key: 'commerce',
              label: 'Commerce',
              type: 'text',
              required: true,
            },
          ],
        })
        .expect(201)
    ).body;
    const mission = (
      await lead.api
        .post('/missions', {
          zoneIds: [plateau.id, cocody.id],
          typeId: type.id,
          title: '10 visites',
          assigneeGroupId: (await t.admin.api.get('/groups').expect(200))
            .body[0].id,
          progressMethod: 'count',
          targetValue: 10,
        })
        .expect(201)
    ).body;
    await agent.api.post('/days/start').expect(200);
    const form = await agent.api
      .post(`/missions/${mission.id}/submissions`, {
        clientId: crypto.randomUUID(),
        data: { commerce: 'Boutique' },
        submittedAt: new Date().toISOString(),
      })
      .expect(201);
    await lead.api
      .post(`/submissions/${form.body.id}/reject`, { reason: 'Doublon' })
      .expect(200);

    const list = (await t.admin.api.get('/team-leads').expect(200)).body;
    const stats = list.leads.find((l: Body) => l.id === lead.id);
    expect(stats).toMatchObject({
      agents: 2,
      groups: [{ name: 'Nord' }],
      requestsReceived: 3,
      requestsDecided: 2,
      requestsRejected: 1,
      requestsPending: 1,
      requestsUnanswered: 0,
      reassignments: 1,
      formsRejected: 1,
      missionsCreated: 1,
      logins: 1,
    });
    expect(stats.avgResponseSeconds).toBeGreaterThanOrEqual(0);
    expect(stats.lastLoginAt).not.toBeNull();
    expect(list.leads.find((l: Body) => l.id === idle.id)).toMatchObject({
      agents: 0,
      requestsDecided: 0,
      groups: [],
    });

    // Fiche : ses agents.
    const detail = (await t.admin.api.get(`/team-leads/${lead.id}`).expect(200))
      .body;
    expect(detail.agents.map((a: Body) => a.id).sort()).toEqual(
      [agent.id, other.id].sort(),
    );

    // Fil d'actions, du plus récent au plus ancien, filtrable par type.
    const timeline = (
      await t.admin.api.get(`/team-leads/${lead.id}/timeline`).expect(200)
    ).body;
    expect(timeline.items.map((e: Body) => e.type)).toEqual([
      'submission.rejected',
      'mission.created',
      'zone.reassigned',
      'zone.approved',
      'zone.rejected',
      'login',
    ]);
    expect(timeline.items[0]).toMatchObject({
      detail: 'Doublon',
      mission: { id: mission.id, title: '10 visites' },
      agent: { id: agent.id },
    });
    expect(timeline.items[4]).toMatchObject({
      zone: 'Cocody',
      detail: 'Zone déjà couverte',
    });
    expect(timeline.items[4].responseSeconds).toBeGreaterThanOrEqual(0);
    const onlyZones = (
      await t.admin.api
        .get(
          `/team-leads/${lead.id}/timeline?types=zone.approved,zone.rejected`,
        )
        .expect(200)
    ).body;
    expect(onlyZones.total).toBe(2);
    const paged = (
      await t.admin.api
        .get(`/team-leads/${lead.id}/timeline?limit=2&page=2`)
        .expect(200)
    ).body;
    expect(paged.items.map((e: Body) => e.type)).toEqual([
      'zone.reassigned',
      'zone.approved',
    ]);

    // Période vide, erreurs, droits.
    const past = (
      await t.admin.api
        .get('/team-leads?from=2020-01-01&to=2020-01-31')
        .expect(200)
    ).body;
    expect(past.leads.find((l: Body) => l.id === lead.id).requestsDecided).toBe(
      0,
    );
    await t.admin.api
      .get('/team-leads?from=2026-02-10&to=2026-02-01')
      .expect(400);
    await t.admin.api
      .get(`/team-leads/${lead.id}/timeline?types=inconnu`)
      .expect(400);
    await t.admin.api.get(`/team-leads/${agent.id}`).expect(404);
    await lead.api.get('/team-leads').expect(403);
    await agent.api.get(`/team-leads/${lead.id}/timeline`).expect(403);
  });
});

describe('Utilisateurs : filtres et statistiques', () => {
  it('filtre par statut, groupe, activité et numéro, et compte par catégorie', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const lead = await t.createUser('team_lead');
    const working = await t.createUser('agent');
    const never = await t.createUser('agent');
    const off = await t.createUser('agent');
    const trial = await t.createUser('agent', { onProbation: true });
    await t.createGroup('Nord', lead.id, [working.id, never.id], []);
    await t.admin.api
      .patch(`/users/${off.id}`, { isActive: false })
      .expect(200);
    await working.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await working.api.post('/days/start').expect(200);

    const ids = async (q: string) =>
      (
        (await t.admin.api.get(`/users?${q}`).expect(200)).body.items as Body[]
      ).map((u) => u.id);
    expect(await ids('activity=working')).toEqual([working.id]);
    expect((await ids('activity=never')).sort()).toEqual(
      [never.id, off.id, trial.id].sort(),
    );
    expect(await ids('status=inactive')).toEqual([off.id]);
    expect(await ids('status=probation')).toEqual([trial.id]);
    expect((await ids('withoutGroup=true')).sort()).toEqual(
      [off.id, trial.id].sort(),
    );

    const row = (await t.admin.api.get('/users?activity=working').expect(200))
      .body.items[0];
    expect(row).toMatchObject({ working: true, days30: 1 });
    expect(row.lastDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const phone = (row.phone as string).slice(-6);
    expect(await ids(`search=${phone}`)).toEqual([working.id]);

    const stats = (await t.admin.api.get('/users/stats').expect(200)).body;
    expect(stats).toMatchObject({
      agents: 4,
      teamLeads: 1,
      admins: 1,
      inactive: 1,
      probation: 1,
      withoutGroup: 1,
      working: 1,
      never: 2,
    });
    // Le chef ne compte que ses agents.
    const leadStats = (await lead.api.get('/users/stats').expect(200)).body;
    expect(leadStats).toMatchObject({ agents: 2, working: 1, never: 1 });
    await working.api.get('/users/stats').expect(403);
    await t.admin.api.get('/users?activity=parti').expect(400);
  });
});

describe('Statistiques globales', () => {
  it('résume l’activité de la période et la compare à la précédente', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 2 });
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = await agent.api.post('/days/start').expect(200);
    // Positions postérieures au démarrage de la journée.
    await new Promise((r) => setTimeout(r, 1200));
    const at = (ms: number) => new Date(Date.now() - ms).toISOString();
    await agent.api
      .post('/positions/batch', {
        dayId: day.body.id,
        points: [
          { lat: 5.3204, lng: -4.0161, accuracy: 5, recordedAt: at(800) },
          { lat: 5.3254, lng: -4.0161, accuracy: 5, recordedAt: at(300) },
        ],
      })
      .expect(200);

    const stats = (await t.admin.api.get('/stats/overview').expect(200)).body;
    expect(stats.kpis).toMatchObject({
      activeAgents: 1,
      totalAgents: 2,
      days: 1,
      positions: 2,
      requests: { total: 1 },
      missions: { open: 0 },
    });
    // 0,005° de latitude ≈ 556 m.
    expect(stats.kpis.distanceKm).toBeCloseTo(0.6, 1);
    expect(stats.previousKpis).toMatchObject({ activeAgents: 0, days: 0 });
    expect(stats.daily).toHaveLength(30);
    expect(stats.daily.at(-1)).toMatchObject({ activeAgents: 1, days: 1 });
    expect(stats.groups).toEqual([
      expect.objectContaining({
        id: group.id,
        agents: 1,
        activeAgents: 1,
        days: 1,
      }),
    ]);
    expect(stats.zones[0]).toMatchObject({ id: zone.id, days: 1, agents: 1 });
    expect(stats.agents).toEqual([
      expect.objectContaining({ id: agent.id, days: 1, groupName: 'Nord' }),
    ]);

    // Détail d'un agent ou d'une zone.
    const byAgent = (
      await t.admin.api.get(`/stats/overview?agentId=${agent.id}`).expect(200)
    ).body;
    expect(byAgent.kpis).toMatchObject({ activeAgents: 1, days: 1 });
    const byOther = (
      await t.admin.api.get(`/stats/overview?agentId=${other.id}`).expect(200)
    ).body;
    expect(byOther.kpis).toMatchObject({ activeAgents: 0, positions: 0 });
    const byZone = (
      await t.admin.api.get(`/stats/overview?zoneId=${zone.id}`).expect(200)
    ).body;
    expect(byZone.kpis.days).toBe(1);
    expect(byZone.zones).toHaveLength(1);
    const otherZone = (
      await t.admin.api
        .get(`/stats/overview?zoneId=${crypto.randomUUID()}`)
        .expect(200)
    ).body;
    expect(otherZone.kpis).toMatchObject({ days: 0, positions: 0 });

    // Filtre par groupe, période, erreurs et droits.
    const empty = (
      await t.admin.api
        .get(`/stats/overview?groupId=${crypto.randomUUID()}`)
        .expect(200)
    ).body;
    expect(empty.kpis.activeAgents).toBe(0);
    const week = (
      await t.admin.api
        .get('/stats/overview?from=2026-01-01&to=2026-01-07')
        .expect(200)
    ).body;
    expect(week.daily).toHaveLength(7);
    expect(week.previous).toEqual({ from: '2025-12-25', to: '2025-12-31' });
    await t.admin.api
      .get('/stats/overview?from=2026-02-10&to=2026-02-01')
      .expect(400);
    await t.admin.api
      .get('/stats/overview?from=2024-01-01&to=2026-01-01')
      .expect(400);
    await lead.api.get('/stats/overview').expect(403);
    await other.api.get('/stats/overview').expect(403);
  });
});

describe('Abonnement des structures', () => {
  it('essai, formules, engagement annuel, facture, impayé, suspension puis réactivation', async () => {
    const t = await newTenant(app);
    const tenantId = t.tenantId;
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const agent = await t.createUser('agent');

    // Essai gratuit : formule Avancée, toutes les fonctionnalités ouvertes.
    const trial = (await t.admin.api.get('/subscription').expect(200)).body;
    expect(trial.subscription).toMatchObject({
      status: 'trialing',
      planCode: 'advanced',
      billingCycle: 'monthly',
    });
    expect(trial.trialDaysLeft).toBe(14);
    expect(trial.plans.map((p: Body) => p.code)).toEqual([
      'base',
      'advanced',
      'enterprise',
    ]);
    const me = (await t.admin.api.get('/auth/me').expect(200)).body;
    expect(me.subscription.features).toHaveLength(10);
    await t.admin.api.get('/stats/overview').expect(200);

    // Engagement annuel : remise, et pas de retour au mensuel avant son terme.
    const annual = (
      await t.admin.api
        .patch('/subscription', { planCode: 'base', billingCycle: 'annual' })
        .expect(200)
    ).body;
    expect(annual.subscription.commitmentEndsAt).not.toBeNull();
    expect(annual.estimate).toMatchObject({
      discountPercent: 15,
      basePrice: 5000,
    });
    await t.admin.api
      .patch('/subscription', { billingCycle: 'monthly' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('COMMITMENT_ACTIVE'));

    // Fin d'essai : seules les fonctionnalités de la formule Base restent ouvertes.
    await owner.query(
      `UPDATE subscriptions SET trial_ends_at = date_trunc('month', now()) WHERE tenant_id = $1`,
      [tenantId],
    );
    await jobs.subscriptions();
    expect(
      (await t.admin.api.get('/subscription').expect(200)).body.subscription
        .status,
    ).toBe('active');
    await t.admin.api
      .get('/stats/overview')
      .expect(402)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'FEATURE_NOT_IN_PLAN',
          requiredPlan: 'enterprise',
        }),
      );
    await t.admin.api
      .get('/missions')
      .expect(402)
      .expect((r) => expect(r.body.requiredPlan).toBe('advanced'));
    await t.admin.api.patch('/settings', { useGroups: true }).expect(402);
    expect(
      (await t.admin.api.get('/auth/me').expect(200)).body.subscription
        .features,
    ).toEqual([]);

    // Une formule inférieure est refusée tant que ses fonctionnalités sont utilisées.
    await t.admin.api
      .patch('/subscription', { planCode: 'advanced' })
      .expect(200);
    await t.admin.api.patch('/settings', { useGroups: true }).expect(200);
    await t.admin.api
      .patch('/subscription', { planCode: 'base' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_DOWNGRADE_BLOCKED'));

    // Facture du mois : forfait Avancée, remise annuelle déduite.
    await t.admin.api.patch('/settings', { useGroups: false }).expect(200);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    const nextMonth = new Date();
    nextMonth.setUTCDate(1);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(2);
    await jobs.subscriptions(nextMonth);
    await jobs.subscriptions(nextMonth); // idempotent
    const invoices = (
      await t.admin.api.get('/subscription/invoices').expect(200)
    ).body;
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      planCode: 'advanced',
      agents: 1,
      basePrice: 15000,
      extraAgents: 0,
      discountPercent: 15,
      prorataPercent: 100,
      amount: 12750,
      currency: 'XOF',
      status: 'pending',
    });

    // Impayé : en retard après l'échéance, suspendu 15 jours plus tard.
    const due = new Date(invoices[0].dueAt).getTime();
    await jobs.subscriptions(new Date(due + 86400_000));
    expect(
      (await t.admin.api.get('/subscription').expect(200)).body.subscription
        .status,
    ).toBe('past_due');
    await agent.api.get('/days/current').expect(200);
    await jobs.subscriptions(new Date(due + 17 * 86400_000));
    await agent.api
      .get('/days/current')
      .expect(402)
      .expect((r) => expect(r.body.code).toBe('SUBSCRIPTION_SUSPENDED'));
    // L'administrateur garde l'accès à son abonnement et à ses factures.
    await t.admin.api.get('/subscription/invoices').expect(200);
    await agent.api.get('/auth/me').expect(200);
    await t.admin.api.get('/users').expect(402);

    // Paiement enregistré : l'accès revient.
    await owner.query(
      `UPDATE invoices SET status = 'paid', paid_at = now() WHERE tenant_id = $1`,
      [tenantId],
    );
    await jobs.subscriptions(new Date(due + 18 * 86400_000));
    await agent.api.get('/days/current').expect(200);
    await agent.api.get('/subscription').expect(403);
  });
});

describe('Missions : recherche, type et tri', () => {
  it('filtre la liste par titre et par type, et trie par échéance', async () => {
    const t = await newTenant(app);
    const zone = await t.createZone('Plateau', PLATEAU);
    await t.settings({ submissionRequiresDay: false });
    const agent = await t.createUser('agent');
    const fields = [
      { key: 'commerce', label: 'Commerce', type: 'text', required: true },
    ];
    const visit = (
      await t.admin.api
        .post('/mission-types', { name: 'Visite', fields })
        .expect(201)
    ).body;
    const audit = (
      await t.admin.api
        .post('/mission-types', { name: 'Audit', fields })
        .expect(201)
    ).body;
    const create = (title: string, typeId: string, days: number) =>
      t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId,
          title,
          assigneeAgentId: agent.id,
          progressMethod: 'count',
          targetValue: 5,
          dueDate: new Date(Date.now() + days * 86400_000).toISOString(),
        })
        .expect(201);
    await create('Visites Plateau', visit.id, 10);
    await create('Visites Cocody', visit.id, 2);
    await create('Audit pharmacies', audit.id, 5);

    const titles = async (q: string) =>
      (
        (await t.admin.api.get(`/missions?${q}`).expect(200)).body
          .items as Body[]
      ).map((m) => m.title);
    expect(await titles('search=visites&sort=title')).toEqual([
      'Visites Cocody',
      'Visites Plateau',
    ]);
    expect(await titles(`typeId=${audit.id}`)).toEqual(['Audit pharmacies']);
    expect(await titles('sort=due')).toEqual([
      'Visites Cocody',
      'Audit pharmacies',
      'Visites Plateau',
    ]);
    await t.admin.api.get('/missions?sort=hasard').expect(400);
  });
});

describe('Quotas des formules', () => {
  it('bloque au-delà du quota, débloque avec des agents supplémentaires', async () => {
    const t = await newTenant(app);
    await t.admin.api.patch('/subscription', { planCode: 'base' }).expect(200);
    // Fin d'essai : les quotas de la formule Base s'appliquent (1 chef, 10 agents).
    await owner.query(
      `UPDATE subscriptions SET trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.subscriptions();
    const agents = [];
    for (let i = 0; i < 10; i++) agents.push(await t.createUser('agent'));
    await t.createUser('team_lead');

    const extra = (role: string) =>
      t.admin.api.post('/users', {
        email: uniqueEmail(role),
        password: PASSWORD,
        firstName: 'Extra',
        lastName: role,
        role,
        phone: uniquePhone(),
      });
    await extra('agent')
      .expect(409)
      .expect((r) =>
        expect(r.body).toMatchObject({
          code: 'QUOTA_EXCEEDED',
          used: 10,
          limit: 10,
        }),
      );
    await extra('team_lead').expect(409);

    // Désactiver libère une place ; réactiver au-delà du quota est refusé.
    await t.admin.api
      .patch(`/users/${agents[0].id}`, { isActive: false })
      .expect(200);
    await extra('agent').expect(201);
    await t.admin.api
      .patch(`/users/${agents[0].id}`, { isActive: true })
      .expect(409);

    // Agents supplémentaires : le quota et le montant augmentent.
    const bought = (
      await t.admin.api.patch('/subscription', { extraAgents: 2 }).expect(200)
    ).body;
    expect(bought.usage.agents).toMatchObject({
      used: 10,
      included: 10,
      extra: 2,
      limit: 12,
    });
    expect(bought.estimate).toMatchObject({
      basePrice: 5000,
      extraAgents: 2,
      extraAgentPrice: 500,
    });
    await t.admin.api
      .patch(`/users/${agents[0].id}`, { isActive: true })
      .expect(200);

    // Revenir sans agents supplémentaires est refusé tant qu'ils sont utilisés.
    await t.admin.api
      .patch('/subscription', { extraAgents: 0 })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_DOWNGRADE_BLOCKED'));
    const stats = (await t.admin.api.get('/users/stats').expect(200)).body;
    expect(stats.quota.agents).toMatchObject({ used: 11, limit: 12 });
  });
});

describe('Alertes intelligentes des responsables', () => {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  // 500 m à l'est du centre du Plateau (reste dans la zone : pas de sortie).
  const moved = { lat: 5.32, lng: -4.0155 };

  async function setup() {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const otherLead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    await t.createGroup('Sud', otherLead.id, [], []);
    return { t, zone, lead, otherLead, agent, group };
  }
  const alertTypes = async (api: Api, query = '') =>
    ((await api.get(`/alerts${query}`).expect(200)).body as Body[])
      .map((a) => a.type as string)
      .sort();
  const notified = async (api: Api) =>
    ((await api.get('/notifications').expect(200)).body as Body[])
      .filter((n) => String(n.type).startsWith('alert.'))
      .map((n) => n.type as string)
      .sort();

  it('immobile, batterie faible, signal perdu, position simulée : ouverture, fermeture, prise en charge', async () => {
    const { t, lead, otherLead, agent, zone } = await setup();
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;
    await owner.query(
      `UPDATE work_days SET started_at = now() - interval '2 hours' WHERE id = $1`,
      [day.id],
    );
    const send = (...points: object[]) =>
      agent.api.post('/positions/batch', { dayId: day.id, points }).expect(200);

    // Une heure au même endroit, batterie à 12 %.
    await send(
      ...[60, 50, 40, 30, 20, 10, 0].map((m) =>
        point(ago(m), IN_PLATEAU, { batteryLevel: 0.12 }),
      ),
    );
    await jobs.everyMinute();
    expect(await alertTypes(lead.api)).toEqual(['immobile', 'low_battery']);
    expect(await notified(lead.api)).toEqual([
      'alert.immobile',
      'alert.low_battery',
    ]);
    expect(await alertTypes(otherLead.api)).toEqual([]);
    await agent.api.get('/alerts').expect(403);
    // Carte en direct : les alertes en cours de l'agent.
    const live = (await lead.api.get('/live').expect(200)).body as Body[];
    expect([...live[0].alerts].sort()).toEqual(['immobile', 'low_battery']);
    expect(
      ((await lead.api.get('/notifications').expect(200)).body as Body[]).find(
        (n) => n.type === 'alert.immobile',
      )!.body,
    ).toMatch(/depuis \d+ min/);

    // Deuxième passage : pas de doublon.
    await jobs.everyMinute();
    expect(await notified(lead.api)).toHaveLength(2);

    // Prise en charge par son chef seulement.
    const [immobile] = (await lead.api.get('/alerts?type=immobile').expect(200))
      .body as Body[];
    await otherLead.api.post(`/alerts/${immobile.id}/ack`, {}).expect(403);
    const acked = (
      await lead.api
        .post(`/alerts/${immobile.id}/ack`, {
          note: 'Appelé : client en réunion',
        })
        .expect(201)
    ).body;
    expect(acked).toMatchObject({
      note: 'Appelé : client en réunion',
      acknowledgedBy: { id: lead.id },
    });

    // Il repart, batterie rechargée : les deux alertes se referment.
    await send(point(new Date(), moved, { batteryLevel: 0.5 }));
    await jobs.everyMinute();
    expect(await alertTypes(lead.api)).toEqual([]);
    expect(await alertTypes(lead.api, '?status=resolved')).toEqual([
      'immobile',
      'low_battery',
    ]);

    // Plus aucune position depuis 30 min : signal perdu, puis retour du signal.
    await owner.query(
      `UPDATE positions SET recorded_at = recorded_at - interval '30 minutes' WHERE day_id = $1`,
      [day.id],
    );
    await jobs.everyMinute();
    expect(await alertTypes(lead.api)).toContain('signal_lost');
    await send(point(new Date(), moved, { batteryLevel: 0.5 }));
    await jobs.everyMinute();
    expect(await alertTypes(lead.api)).not.toContain('signal_lost');

    // Fausse position : jusqu'à la fin de la journée, qui referme tout.
    await send(point(new Date(Date.now() + 1000), moved, { isMocked: true }));
    await jobs.everyMinute();
    expect(await alertTypes(lead.api)).toEqual(['mocked']);
    await agent.api.post('/days/end').expect(200);
    expect(await alertTypes(lead.api)).toEqual([]);

    // Réglages : seuils bornés, alerte désactivable.
    await t.admin.api
      .patch('/settings', { alertBatteryPercent: 90 })
      .expect(400);
    await t.admin.api
      .patch('/settings', {
        alertBatteryPercent: null,
        alertImmobileMinutes: null,
      })
      .expect(200);
  });

  it('journée pas démarrée : un message groupé par chef, refermé au démarrage', async () => {
    const { t, lead, agent, zone, group } = await setup();
    const second = await t.createUser('agent');
    const fresh = await t.createUser('agent');
    await t.admin.api
      .put(`/groups/${group.id}/members`, {
        ids: [agent.id, second.id, fresh.id],
      })
      .expect(200);

    // Agent et second ont travaillé hier ; fresh n'a jamais travaillé.
    for (const a of [agent, second]) {
      await a.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
      await a.api.post('/days/start').expect(200);
      await a.api.post('/days/end').expect(200);
    }
    await owner.query(
      `UPDATE work_days SET work_date = work_date - 1, started_at = started_at - interval '1 day',
              ended_at = ended_at - interval '1 day' WHERE tenant_id = $1`,
      [t.tenantId],
    );

    // Heure attendue juste passée (fuseau d'Abidjan = UTC), sans marge, tous les jours.
    const now = new Date();
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    const start = minutes - Math.min(10, minutes);
    const hhmm = `${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}`;
    await t.settings({
      alertStartTime: hhmm,
      alertLateMinutes: 0,
      alertWorkdays: [1, 2, 3, 4, 5, 6, 7],
    });

    await jobs.everyMinute();
    const notes = (
      (await lead.api.get('/notifications').expect(200)).body as Body[]
    ).filter((n) => n.type === 'alert.late_start');
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('2 agents n’ont pas démarré leur journée');
    expect(await alertTypes(lead.api)).toEqual(['late_start', 'late_start']);
    await jobs.everyMinute();
    expect(
      (
        (await lead.api.get('/notifications').expect(200)).body as Body[]
      ).filter((n) => n.type === 'alert.late_start'),
    ).toHaveLength(1);

    // Il démarre : son alerte se referme.
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    const open = (await lead.api.get('/alerts').expect(200)).body as Body[];
    expect(open.map((a) => (a.agent as Body).id)).toEqual([second.id]);
  });
});

describe('Rémunération (formule Entreprise)', () => {
  it('calcule automatiquement, ajuste, valide, marque payé et réserve la fonction à Entreprise', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const lead = await t.createUser('team_lead');
    const a = await t.createUser('agent');
    const b = await t.createUser('agent');
    const outsider = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [a.id, b.id], [zone.id]);

    // Activité de l'agent A : une journée et deux formulaires sur une mission atteinte.
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [
            {
              key: 'commerce',
              label: 'Commerce',
              type: 'text',
              required: true,
            },
          ],
        })
        .expect(201)
    ).body;
    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: '2 visites',
          assigneeGroupId: group.id,
          progressMethod: 'count',
          targetValue: 2,
          dueDate: new Date(Date.now() + 3600_000).toISOString(),
        })
        .expect(201)
    ).body;
    await a.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await a.api.post('/days/start').expect(200);
    for (const commerce of ['Boutique', 'Pharmacie'])
      await a.api
        .post(`/missions/${mission.id}/submissions`, {
          clientId: crypto.randomUUID(),
          data: { commerce },
          submittedAt: new Date().toISOString(),
        })
        .expect(201);
    await a.api.post('/days/end').expect(200);

    // Grilles : une pour les agents, une pour les chefs.
    await t.admin.api
      .post('/pay/grids', { name: 'X', components: { fixed: -5 }, targets: {} })
      .expect(400);
    await t.admin.api
      .post('/pay/grids', {
        name: 'Agents terrain',
        components: {
          fixed: 10000,
          perDay: { amount: 2000 },
          perForm: { amount: 500 },
          objectiveBonus: [{ thresholdPercent: 100, amount: 5000 }],
          deductions: { perRejectedForm: 300 },
        },
        targets: { roles: ['agent'] },
      })
      .expect(201);
    await t.admin.api
      .post('/pay/grids', {
        name: 'Chefs',
        components: { fixed: 20000, teamBonus: { perTeamForm: 100 } },
        targets: { roles: ['team_lead'] },
      })
      .expect(201);

    // Estimation en direct.
    const totalOf = (lines: Body[], id: string) =>
      lines.find((l) => (l.user as Body).id === id)?.gross;
    const current = (await t.admin.api.get('/pay/current').expect(200)).body;
    expect(totalOf(current.lines, a.id)).toBe(18000); // 10 000 + 2 000 + 2 × 500 + 5 000
    expect(totalOf(current.lines, b.id)).toBe(10000);
    expect(totalOf(current.lines, lead.id)).toBe(20200);
    const mine = (await a.api.get('/pay/me').expect(200)).body;
    expect(mine.current.line.gross).toBe(18000);
    expect(mine.current.line.items.map((i: Body) => i.code)).toEqual(
      expect.arrayContaining([
        'fixed',
        'days',
        `forms:${type.id}`,
        `objective:${mission.id}`,
      ]),
    );
    const leadView = (await lead.api.get('/pay/current').expect(200)).body;
    expect(leadView.lines.map((l: Body) => (l.user as Body).id).sort()).toEqual(
      [a.id, b.id, lead.id].sort(),
    );
    await t.admin.api.post('/pay/runs', {}).expect(201); // période précédente, vide
    await t.admin.api
      .post('/pay/runs', { date: new Date().toISOString().slice(0, 10) })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PERIOD_NOT_OVER'));

    // Activité déplacée de 40 jours : sa période est terminée, la paie se calcule.
    for (const sql of [
      `UPDATE work_days SET work_date = work_date - 40, started_at = started_at - interval '40 days', ended_at = ended_at - interval '40 days' WHERE tenant_id = $1`,
      `UPDATE day_pauses SET started_at = started_at - interval '40 days', ended_at = ended_at - interval '40 days' WHERE tenant_id = $1`,
      `UPDATE positions SET recorded_at = recorded_at - interval '40 days' WHERE tenant_id = $1`,
      `UPDATE mission_submissions SET submitted_at = submitted_at - interval '40 days' WHERE tenant_id = $1`,
      `UPDATE missions SET due_date = due_date - interval '40 days' WHERE tenant_id = $1`,
    ])
      await owner.query(sql, [t.tenantId]);
    const past = new Date(Date.now() - 40 * 86400_000)
      .toISOString()
      .slice(0, 10);
    const run = (
      await t.admin.api.post('/pay/runs', { date: past }).expect(201)
    ).body;
    expect(run.status).toBe('draft');
    const lineOf = async (id: string) =>
      (
        (await t.admin.api.get(`/pay/runs/${run.id}`).expect(200)).body
          .lines as Body[]
      ).find((l) => l.userId === id)!;
    expect((await lineOf(a.id)).total).toBe(18000);

    // Le chef propose pour son équipe ; l'administrateur décide.
    const proposed = (
      await lead.api
        .post(`/pay/runs/${run.id}/adjustments`, {
          userId: a.id,
          amount: 1000,
          reason: 'Excellent travail',
        })
        .expect(201)
    ).body;
    expect(proposed.status).toBe('proposed');
    // Liste des paies : le chef ne voit que les chiffres de son équipe.
    const adminRun = (await t.admin.api.get('/pay/runs').expect(200)).body.find(
      (r: Body) => r.id === run.id,
    );
    const leadRun = (await lead.api.get('/pay/runs').expect(200)).body.find(
      (r: Body) => r.id === run.id,
    );
    expect(leadRun.lines).toBeLessThan(adminRun.lines);
    expect(leadRun.pending).toBe(1);
    await lead.api
      .post(`/pay/runs/${run.id}/adjustments`, {
        userId: outsider.id,
        amount: 500,
        reason: 'Hors équipe',
      })
      .expect(403);
    await t.admin.api
      .post(`/pay/runs/${run.id}/validate`)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PENDING_ADJUSTMENTS'));
    await t.admin.api
      .post(`/pay/adjustments/${proposed.id}/decision`, { approve: true })
      .expect(200);
    await t.admin.api
      .post(`/pay/runs/${run.id}/adjustments`, {
        userId: b.id,
        amount: -500,
        reason: 'Retard répété',
      })
      .expect(201);
    expect(await lineOf(a.id)).toMatchObject({
      gross: 18000,
      adjustments: 1000,
      total: 19000,
    });
    expect((await lineOf(b.id)).total).toBe(9500);

    // Recalcul : les ajustements sont conservés.
    await t.admin.api.post(`/pay/runs/${run.id}/recalculate`).expect(200);
    expect((await lineOf(a.id)).total).toBe(19000);

    // Validation : verrouillée et notifiée ; paiement hors plateforme enregistré.
    await t.admin.api.post(`/pay/runs/${run.id}/paid`, {}).expect(409);
    await t.admin.api.post(`/pay/runs/${run.id}/validate`).expect(200);
    await t.admin.api.post(`/pay/runs/${run.id}/recalculate`).expect(409);
    expect(
      ((await a.api.get('/notifications').expect(200)).body as Body[]).some(
        (n) => n.type === 'pay.validated',
      ),
    ).toBe(true);
    const partial = (
      await t.admin.api
        .post(`/pay/runs/${run.id}/paid`, {
          userIds: [a.id],
          reference: 'OM-2026-001',
        })
        .expect(200)
    ).body;
    expect(partial).toMatchObject({ paid: 1 });
    await t.admin.api.post(`/pay/runs/${run.id}/paid`, {}).expect(200);
    const runs = (await t.admin.api.get('/pay/runs').expect(200))
      .body as Body[];
    expect(runs.find((r) => r.id === run.id)).toMatchObject({ status: 'paid' });
    const history = (await a.api.get('/pay/me').expect(200)).body
      .history as Body[];
    expect(history[0]).toMatchObject({
      total: 19000,
      paymentReference: 'OM-2026-001',
    });
    expect(history[0].adjustmentsDetail).toEqual([
      expect.objectContaining({ amount: 1000, reason: 'Excellent travail' }),
    ]);

    // Droits : un agent ne gère pas la paie.
    await a.api.get('/pay/current').expect(403);
    await a.api.get('/pay/grids').expect(403);

    // Hors formule Entreprise (fin d'essai sur Avancée) : fonction fermée.
    await owner.query(
      `UPDATE subscriptions SET trial_ends_at = date_trunc('month', now()) WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.subscriptions();
    await t.admin.api
      .get('/pay/current')
      .expect(402)
      .expect((r) => expect(r.body.requiredPlan).toBe('enterprise'));
  });

  it('rémunération par type de mission : la mission, sinon son type, sinon la grille', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const lead = await t.createUser('team_lead');
    const a = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [a.id], [zone.id]);
    const newType = async (name: string) =>
      (
        await t.admin.api
          .post('/mission-types', {
            name,
            fields: [
              {
                key: 'commerce',
                label: 'Commerce',
                type: 'text',
                required: true,
              },
            ],
          })
          .expect(201)
      ).body;
    const visite = await newType('Visite');
    const enquete = await newType('Enquête');
    await t.admin.api
      .post('/pay/grids', {
        name: 'Agents',
        components: {
          fixed: 10000,
          perForm: { amount: 500 },
          objectiveBonus: [{ thresholdPercent: 100, amount: 5000 }],
        },
        targets: { roles: ['agent'] },
      })
      .expect(201);
    await t.admin.api
      .post('/pay/grids', {
        name: 'Chefs',
        components: { fixed: 20000, teamBonus: { perTeamForm: 100 } },
        targets: { roles: ['team_lead'] },
      })
      .expect(201);

    // Conditions du type « Visite » : administrateur seulement, invisibles du chef.
    await lead.api
      .put(`/mission-types/${visite.id}/pay`, { perForm: 800 })
      .expect(403);
    await t.admin.api
      .put(`/mission-types/${visite.id}/pay`, {
        perForm: 800,
        leadPerTeamForm: 50,
      })
      .expect(200);
    const leadTypes = (await lead.api.get('/mission-types').expect(200))
      .body as Body[];
    expect(leadTypes.find((x) => x.id === visite.id)).toMatchObject({
      hasPay: true,
    });
    expect(leadTypes.find((x) => x.id === visite.id)!.pay).toBeUndefined();
    expect(
      (
        (await t.admin.api.get(`/mission-types/${visite.id}`).expect(200))
          .body as Body
      ).pay,
    ).toEqual({ perForm: 800, leadPerTeamForm: 50 });

    const mission = async (typeId: string, title: string, pay?: object) =>
      (
        await t.admin.api
          .post('/missions', {
            zoneIds: [zone.id],
            typeId,
            title,
            assigneeGroupId: group.id,
            progressMethod: 'count',
            targetValue: 1,
            dueDate: new Date(Date.now() + 3600_000).toISOString(),
            ...(pay ? { pay } : {}),
          })
          .expect(201)
      ).body as Body;
    const parType = await mission(visite.id, 'Visites du jour');
    const propre = await mission(visite.id, 'Visites VIP', { perForm: 1200 });
    const grille = await mission(enquete.id, 'Enquête quartier');

    // Ce que voit l'agent : la source des conditions.
    const earnings = async (id: string) =>
      ((await a.api.get(`/missions/${id}`).expect(200)).body as Body)
        .myEarnings;
    expect(await earnings(parType.id)).toMatchObject({
      source: 'type',
      perForm: 800,
    });
    expect(await earnings(propre.id)).toMatchObject({
      source: 'mission',
      perForm: 1200,
    });
    expect(await earnings(grille.id)).toMatchObject({
      source: 'grid',
      perForm: 500,
    });

    await a.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await a.api.post('/days/start').expect(200);
    for (const m of [parType, propre, grille])
      await a.api
        .post(`/missions/${m.id}/submissions`, {
          clientId: crypto.randomUUID(),
          data: { commerce: 'Boutique' },
          submittedAt: new Date().toISOString(),
        })
        .expect(201);

    const gross = async (id: string) =>
      (
        (await t.admin.api.get('/pay/current').expect(200)).body.lines as Body[]
      ).find((l) => (l.user as Body).id === id)!.gross;
    // 10 000 + 800 (type) + 1 200 (mission) + 500 (grille) + 5 000 (objectif selon la grille)
    expect(await gross(a.id)).toBe(17500);
    // 20 000 + 50 (type) + 100 (grille, enquête)
    expect(await gross(lead.id)).toBe(20150);

    // Sans conditions de type, « Visites du jour » revient à la grille (formulaire et objectif).
    await t.admin.api.delete(`/mission-types/${visite.id}/pay`).expect(200);
    expect(await earnings(parType.id)).toMatchObject({ source: 'grid' });
    expect(await gross(a.id)).toBe(22200);
    expect(await gross(lead.id)).toBe(20200);
  });

  it('rémunération propre à une mission : remplace la grille, réservée à l’administrateur', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const lead = await t.createUser('team_lead');
    const a = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [a.id], [zone.id]);
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Collecte',
          fields: [
            {
              key: 'commerce',
              label: 'Commerce',
              type: 'text',
              required: true,
            },
            {
              key: 'montant',
              label: 'Montant',
              type: 'number',
              required: true,
            },
          ],
        })
        .expect(201)
    ).body;
    await t.admin.api
      .post('/pay/grids', {
        name: 'Agents',
        components: {
          fixed: 10000,
          perForm: { amount: 500 },
          commission: { percent: 2 },
          objectiveBonus: [{ thresholdPercent: 100, amount: 5000 }],
        },
        targets: { roles: ['agent'] },
      })
      .expect(201);
    await t.admin.api
      .post('/pay/grids', {
        name: 'Chefs',
        components: { fixed: 20000, teamBonus: { perTeamForm: 100 } },
        targets: { roles: ['team_lead'] },
      })
      .expect(201);
    const due = new Date(Date.now() + 3600_000).toISOString();
    const base = {
      typeId: type.id,
      assigneeGroupId: group.id,
      dueDate: due,
    };
    const pay = {
      perForm: 1000,
      commissionPercent: 5,
      objectiveBonus: [
        { thresholdPercent: 100, amount: 8000 },
        { thresholdPercent: 50, amount: 3000 },
      ].reverse(),
      leadPerTeamForm: 200,
    };

    // Le chef crée des missions, mais ne fixe pas leur rémunération.
    await lead.api
      .post('/missions', {
        zoneIds: [zone.id],
        ...base,
        title: 'Chef',
        progressMethod: 'count',
        targetValue: 1,
        pay,
      })
      .expect(403);
    const own = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          ...base,
          title: 'Collecte Mobile Money',
          progressMethod: 'field_sum',
          sumFieldKey: 'montant',
          targetValue: 100000,
          pay,
        })
        .expect(201)
    ).body;
    expect(own.pay.objectiveBonus.map((x: Body) => x.thresholdPercent)).toEqual(
      [100, 50],
    );
    const usual = (
      await lead.api
        .post('/missions', {
          zoneIds: [zone.id],
          ...base,
          title: 'Visite',
          progressMethod: 'count',
          targetValue: 1,
        })
        .expect(201)
    ).body;
    expect(usual.hasOwnPay).toBe(false);
    await lead.api.put(`/missions/${usual.id}/pay`, pay).expect(403);
    await t.admin.api
      .put(`/missions/${usual.id}/pay`, { commissionPercent: 150 })
      .expect(400);

    // Ce que voient le chef et l'agent.
    const leadView = (await lead.api.get(`/missions/${own.id}`).expect(200))
      .body;
    expect(leadView.hasOwnPay).toBe(true);
    expect(leadView.pay).toBeUndefined();
    const agentOwn = (await a.api.get(`/missions/${own.id}`).expect(200)).body;
    expect(agentOwn.pay).toBeUndefined();
    expect(agentOwn.myEarnings).toEqual({
      source: 'mission',
      perForm: 1000,
      commissionPercent: 5,
      objectiveBonus: [
        { thresholdPercent: 100, amount: 8000 },
        { thresholdPercent: 50, amount: 3000 },
      ],
    });
    expect(
      (await a.api.get(`/missions/${usual.id}`).expect(200)).body.myEarnings,
    ).toEqual({
      source: 'grid',
      perForm: 500,
      commissionPercent: null,
      objectiveBonus: [{ thresholdPercent: 100, amount: 5000 }],
    });

    // Activité : 1 visite (grille), 2 collectes de 30 000 (60 % de l'objectif).
    await a.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await a.api.post('/days/start').expect(200);
    const submit = (missionId: string, montant: number) =>
      a.api
        .post(`/missions/${missionId}/submissions`, {
          clientId: crypto.randomUUID(),
          data: { commerce: 'Boutique', montant },
          submittedAt: new Date().toISOString(),
        })
        .expect(201);
    await submit(usual.id, 20000);
    await submit(own.id, 30000);
    await submit(own.id, 30000);

    const lineOf = async (id: string) =>
      (
        (await t.admin.api.get('/pay/current').expect(200)).body.lines as Body[]
      ).find((l) => (l.user as Body).id === id)!;
    let line = await lineOf(a.id);
    // 10 000 + 500 (visite) + 5 000 (visite atteinte) + 2 × 1 000 + 5 % × 60 000 + 3 000 (palier 50 %)
    expect(line.gross).toBe(23500);
    expect(line.items.map((i: Body) => i.code)).toEqual(
      expect.arrayContaining([
        `forms:${type.id}`,
        `objective:${usual.id}`,
        `mission_forms:${own.id}`,
        `mission_commission:${own.id}`,
        `objective:${own.id}`,
      ]),
    );
    expect(line.items.some((i: Body) => i.code === 'commission')).toBe(false);
    // Chef : 20 000 + 1 × 100 (grille) + 2 × 200 (mission)
    expect((await lineOf(lead.id)).gross).toBe(20500);

    // Retour à la grille : 10 000 + 3 × 500 + 2 % × 60 000 + 5 000 ; chef : 20 000 + 3 × 100.
    const cleared = (
      await t.admin.api.delete(`/missions/${own.id}/pay`).expect(200)
    ).body;
    expect(cleared).toMatchObject({ hasOwnPay: false, pay: null });
    line = await lineOf(a.id);
    expect(line.gross).toBe(17700);
    expect((await lineOf(lead.id)).gross).toBe(20300);

    // Hors formule Entreprise : plus de rémunération propre.
    await owner.query(
      `UPDATE subscriptions SET trial_ends_at = date_trunc('month', now()) WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.subscriptions();
    await t.admin.api
      .put(`/missions/${own.id}/pay`, { perForm: 800 })
      .expect(402);
    expect(
      (await a.api.get(`/missions/${own.id}`).expect(200)).body.myEarnings,
    ).toBeNull();
  });
});

describe('Exports Excel et CSV', () => {
  /** Corps binaire (fichier) d'une réponse supertest. */
  const binary = (
    res: NodeJS.ReadableStream,
    cb: (e: Error | null, b: Buffer) => void,
  ) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  };
  const today = () => new Date().toISOString().slice(0, 10);

  it('journées et formulaires : Excel typé, CSV pour Excel, périmètre du chef, journal', async () => {
    const t = await newTenant(app);
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    const lead = await t.createUser('team_lead');
    const a = await t.createUser('agent');
    const outsider = await t.createUser('agent');
    const group = await t.createGroup('Nord', lead.id, [a.id], [zone.id]);
    await t.createGroup(
      'Sud',
      (await t.createUser('team_lead')).id,
      [outsider.id],
      [zone.id],
    );

    for (const agent of [a, outsider]) {
      await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
      await agent.api.post('/days/start').expect(200);
    }
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Collecte',
          fields: [
            { key: 'client', label: 'Client', type: 'text', required: true },
            {
              key: 'montant',
              label: 'Montant',
              type: 'number',
              required: true,
            },
            { key: 'paye', label: 'Payé', type: 'boolean', required: false },
          ],
        })
        .expect(201)
    ).body;
    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: 'Collecte Plateau',
          assigneeGroupId: group.id,
          progressMethod: 'count',
          targetValue: 10,
        })
        .expect(201)
    ).body;
    const sent = [];
    for (const [client, montant] of [
      ['Boutique ; Aïcha', 15000],
      ['Pharmacie', 22500.5],
    ] as const)
      sent.push(
        (
          await a.api
            .post(`/missions/${mission.id}/submissions`, {
              clientId: crypto.randomUUID(),
              data: { client, montant, paye: true },
              submittedAt: new Date().toISOString(),
              lat: 5.32,
              lng: -4.02,
            })
            .expect(201)
        ).body,
      );
    await lead.api
      .post(`/submissions/${sent[1].id}/reject`, {
        reason: 'Montant à vérifier',
      })
      .expect(200);
    await a.api.post('/days/end').expect(200);

    // Journées en Excel : en-têtes, valeurs typées.
    const xlsx = await t.admin.api
      .get(`/exports/days?from=${today()}&to=${today()}`)
      .buffer(true)
      .parse(binary as never)
      .expect(200)
      .expect('Content-Type', /spreadsheetml/)
      .expect(
        'Content-Disposition',
        new RegExp(`suivi-agent_journees_${today()}_${today()}\\.xlsx`),
      );
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body as ArrayBuffer);
    const ws = wb.getWorksheet('Journées')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Date');
    expect(ws.rowCount).toBe(3); // en-tête + 2 journées
    const names = [
      ws.getRow(2).getCell(3).value,
      ws.getRow(3).getCell(3).value,
    ];
    expect(names).toEqual(['agent', 'agent']);
    expect(ws.getRow(2).getCell(1).value).toBeInstanceOf(Date);

    // Le chef n'exporte que son équipe ; CSV pour Excel en français.
    const csv = await lead.api
      .get(`/exports/days?from=${today()}&to=${today()}&format=csv`)
      .expect(200)
      .expect('Content-Type', /text\/csv/);
    const lines = csv.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(
      /^Date;Nom;Prénom;Téléphone;Groupe;Zone;Début;Fin/,
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Nord');
    expect(lines[1]).toContain('Terminée par l’agent');

    // Formulaires : une colonne par champ, accents, « ; » échappés, rejets.
    const subs = await lead.api
      .get(`/exports/submissions?missionId=${mission.id}&format=csv`)
      .expect(200)
      .expect('Content-Disposition', /formulaires_collecte-plateau\.csv/);
    const rows = subs.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(rows[0]).toBe(
      'N°;Date et heure;Mission;Nom;Prénom;Groupe;Client;Montant;Payé;Statut;Motif du rejet;Latitude;Longitude',
    );
    expect(rows[1]).toContain('"Boutique ; Aïcha";15000;Oui;Accepté');
    expect(rows[2]).toContain(
      '22500,5;Oui;Rejeté;Montant à vérifier;5,32;-4,02',
    );
    const typed = await t.admin.api
      .get(`/exports/submissions?typeId=${type.id}`)
      .buffer(true)
      .parse(binary as never)
      .expect(200);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(typed.body as ArrayBuffer);
    expect(wb2.getWorksheet('Formulaires')!.getRow(3).getCell(8).value).toBe(
      22500.5,
    );

    // Erreurs et droits.
    await t.admin.api.get('/exports/submissions').expect(400);
    await t.admin.api
      .get('/exports/days?from=2025-01-01&to=2026-06-01')
      .expect(400);
    await t.admin.api
      .get(`/exports/days?from=${today()}&to=2020-01-01`)
      .expect(400);
    await a.api.get(`/exports/days?from=${today()}&to=${today()}`).expect(403);
    const [logged] = await owner.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1 AND action LIKE 'ExportsController.%'`,
      [t.tenantId],
    );
    expect(logged.n).toBe(4);

    // Formule sans exports (Base, fin d'essai) : fonction fermée.
    await owner.query(
      `UPDATE subscriptions SET plan_code = 'base', trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.subscriptions();
    app.get(SubscriptionsService).invalidateAll();
    await t.admin.api
      .get(`/exports/days?from=${today()}&to=${today()}`)
      .expect(402)
      .expect((r) => expect(r.body.requiredPlan).toBe('advanced'));
  });
});

describe('Bilan de fin de journée et messages d’équipe', () => {
  it('bilan de l’équipe, message aux agents, envoi automatique du bilan', async () => {
    const t = await newTenant(app);
    await t.settings({
      useGroups: true,
      alertStartTime: '00:00',
      alertLateMinutes: 0,
    });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 10 });
    const lead = await t.createUser('team_lead');
    const [a, b, absent] = [
      await t.createUser('agent'),
      await t.createUser('agent'),
      await t.createUser('agent'),
    ];
    const outsider = await t.createUser('agent');
    const group = await t.createGroup(
      'Nord',
      lead.id,
      [a.id, b.id, absent.id],
      [zone.id],
    );
    await t.createGroup(
      'Sud',
      (await t.createUser('team_lead')).id,
      [outsider.id],
      [zone.id],
    );

    for (const agent of [a, b]) {
      await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
      await agent.api.post('/days/start').expect(200);
    }
    const type = (
      await t.admin.api
        .post('/mission-types', {
          name: 'Visite',
          fields: [
            {
              key: 'commerce',
              label: 'Commerce',
              type: 'text',
              required: true,
            },
          ],
        })
        .expect(201)
    ).body;
    const mission = (
      await t.admin.api
        .post('/missions', {
          zoneIds: [zone.id],
          typeId: type.id,
          title: 'Visites',
          assigneeGroupId: group.id,
          progressMethod: 'count',
          targetValue: 5,
        })
        .expect(201)
    ).body;
    const forms = [];
    for (const commerce of ['Boutique', 'Pharmacie'])
      forms.push(
        (
          await a.api
            .post(`/missions/${mission.id}/submissions`, {
              clientId: crypto.randomUUID(),
              data: { commerce },
              submittedAt: new Date().toISOString(),
            })
            .expect(201)
        ).body,
      );
    await lead.api
      .post(`/submissions/${forms[1].id}/reject`, { reason: 'Doublon' })
      .expect(200);
    await owner.query(
      `UPDATE work_days SET started_at = now() - interval '3 hours' WHERE agent_id = $1`,
      [a.id],
    );
    await a.api.post('/days/end').expect(200);

    // Bilan du chef : son équipe seulement.
    const report = (await lead.api.get('/reports/daily').expect(200)).body;
    expect(report.summary).toMatchObject({
      agents: 3,
      worked: 2,
      notStarted: 1,
      formsAccepted: 1,
      formsRejected: 1,
    });
    expect(report.summary.workedMinutes).toBeGreaterThanOrEqual(179);
    const row = (id: string) =>
      (report.agents as Body[]).find((r) => r.id === id)!;
    expect(row(a.id)).toMatchObject({
      status: 'ended',
      formsAccepted: 1,
      zone: 'Plateau',
      late: true,
    });
    expect(row(b.id).status).toBe('working');
    expect(row(absent.id)).toMatchObject({
      status: 'not_started',
      startedAt: null,
    });
    expect(row(outsider.id)).toBeUndefined();
    expect(
      (await t.admin.api.get('/reports/daily').expect(200)).body.summary.agents,
    ).toBe(4);
    await a.api.get('/reports/daily').expect(403);
    await lead.api.get('/reports/daily?date=2026-13-01').expect(400);

    // Message à l'équipe : chaque agent le reçoit ; pas hors de l'équipe.
    const sent = (
      await lead.api
        .post('/team-messages', {
          body: 'Réunion à 17 h au bureau du Plateau.',
        })
        .expect(201)
    ).body;
    expect(sent.recipients).toBe(3);
    const note = (
      (await b.api.get('/notifications').expect(200)).body as Body[]
    ).find((n) => n.type === 'team.message');
    expect(note).toMatchObject({
      body: 'Réunion à 17 h au bureau du Plateau.',
    });
    expect(note!.title).toMatch(/^Message de /);
    await lead.api
      .post('/team-messages', { body: 'Coucou', agentIds: [outsider.id] })
      .expect(400);
    await lead.api
      .post('/team-messages', { body: 'Seulement toi', agentIds: [a.id] })
      .expect(201);
    expect(
      (
        (await outsider.api.get('/notifications').expect(200)).body as Body[]
      ).some((n) => n.type === 'team.message'),
    ).toBe(false);
    await a.api.post('/team-messages', { body: 'Salut' }).expect(403);
    expect(
      (await lead.api.get('/team-messages').expect(200)).body,
    ).toHaveLength(2);

    // Envoi automatique du bilan à l'heure réglée (fuseau d'Abidjan = UTC), une seule fois.
    const now = new Date();
    const hhmm = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
    await t.settings({ dailyReportTime: hhmm });
    await jobs.everyMinute();
    await jobs.everyMinute();
    const reports = (
      (await lead.api.get('/notifications').expect(200)).body as Body[]
    ).filter((n) => n.type === 'report.daily');
    expect(reports).toHaveLength(1);
    expect(reports[0].body).toContain('2/3 agents ont travaillé');
    expect(reports[0].body).toContain('1 absent');
  });
});

describe('Guide « Bien démarrer »', () => {
  it('avance avec les données de la structure, étapes manuelles et masquage', async () => {
    const t = await newTenant(app);
    type State = {
      steps: { key: string; done: boolean; manual: boolean }[];
      dismissed: boolean;
      completed: boolean;
    };
    const state = async () =>
      (await t.admin.api.get('/onboarding').expect(200)).body as State;
    const done = (s: State) =>
      Object.fromEntries(s.steps.map((x) => [x.key, x.done]));

    let s = await state();
    expect(s.steps[0]).toEqual({
      key: 'prerequisites',
      done: false,
      manual: true,
    });
    expect(s.steps.at(-1)?.key).toBe('first_day');
    expect(s.steps.every((x) => !x.done)).toBe(true);
    expect(s.dismissed).toBe(false);

    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 10 });
    const agent = await t.createUser('agent');
    s = await state();
    expect(done(s)).toMatchObject({ zones: true, agents: true, app: true });
    expect(done(s).first_day).toBe(false);

    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    await agent.api.post('/days/start').expect(200);
    expect(done(await state()).first_day).toBe(true);

    await t.admin.api
      .patch('/onboarding', { step: 'prerequisites', done: true })
      .expect(200);
    s = (
      await t.admin.api
        .patch('/onboarding', { step: 'settings', done: true })
        .expect(200)
    ).body as State;
    expect(done(s)).toMatchObject({ prerequisites: true, settings: true });
    await t.admin.api
      .patch('/onboarding', { step: 'settings', done: false })
      .expect(200);
    expect(done(await state()).settings).toBe(false);

    // Les étapes déduites des données ne se cochent pas à la main.
    await t.admin.api
      .patch('/onboarding', { step: 'zones', done: true })
      .expect(400);
    await t.admin.api.patch('/onboarding', { step: 'settings' }).expect(400);

    s = (
      await t.admin.api.patch('/onboarding', { dismissed: true }).expect(200)
    ).body as State;
    expect(s.dismissed).toBe(true);

    // Réservé à l'administrateur, et propre à chaque structure.
    const lead = await t.createUser('team_lead');
    await lead.api.get('/onboarding').expect(403);
    await agent.api.get('/onboarding').expect(403);
    const other = await newTenant(app, 'Autre');
    const fresh = (await other.admin.api.get('/onboarding').expect(200))
      .body as State;
    expect(fresh.dismissed).toBe(false);
    expect(fresh.steps.every((x) => !x.done)).toBe(true);
  });
});

describe('Support et documentation', () => {
  async function platformApi() {
    const email = uniqueEmail('sa-support');
    await owner.query(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Awa', 'Support')`,
      [email, await hashPassword('Editeur2026!')],
    );
    const res = await new Api(app)
      .post('/platform/auth/login', { email, password: 'Editeur2026!' })
      .expect(200);
    return new Api(app, res.body.accessToken as string);
  }

  it('demande d’aide : fil de messages entre la structure et l’éditeur', async () => {
    const t = await newTenant(app);
    const other = await newTenant(app);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const sa = await platformApi();

    await t.admin.api
      .post('/support/tickets', {
        subject: 'Aide',
        category: 'bug',
        message: 'court',
      })
      .expect(400);
    await agent.api
      .post('/support/tickets', {
        subject: 'Carte vide',
        category: 'bug',
        message: 'La carte ne charge pas sur mon téléphone.',
      })
      .expect(403);
    const ticket = (
      await t.admin.api
        .post('/support/tickets', {
          subject: 'Export de la paie',
          category: 'question',
          message: 'Comment exporter la paie pour Orange Money ?',
          context: { page: '/pay', userAgent: 'Chrome', secret: 'x' },
        })
        .expect(201)
    ).body;
    expect(ticket).toMatchObject({ status: 'open', lastAuthor: 'tenant' });
    expect(ticket.number).toBeGreaterThanOrEqual(1001);
    expect(ticket.messages).toHaveLength(1);
    const own = (
      await lead.api
        .post('/support/tickets', {
          subject: 'Agent bloqué',
          category: 'account',
          message: 'Un agent ne peut plus se connecter depuis ce matin.',
        })
        .expect(201)
    ).body;

    // Le chef voit ses demandes ; l'administrateur, toutes ; une autre structure, aucune.
    expect(
      ((await lead.api.get('/support/tickets').expect(200)).body as Body[]).map(
        (x) => x.id,
      ),
    ).toEqual([own.id]);
    expect(
      (await t.admin.api.get('/support/tickets').expect(200)).body,
    ).toHaveLength(2);
    await lead.api.get(`/support/tickets/${ticket.id}`).expect(404);
    await other.admin.api.get(`/support/tickets/${ticket.id}`).expect(404);

    // L'éditeur voit la demande, avec la structure et le contexte filtré.
    const inbox = (await sa.get('/platform/support?status=open').expect(200))
      .body;
    expect(inbox.open).toBeGreaterThanOrEqual(2);
    const row = (inbox.items as Body[]).find((x) => x.id === ticket.id)!;
    expect(row.tenantName).toBeTruthy();
    const detail = (await sa.get(`/platform/support/${ticket.id}`).expect(200))
      .body;
    expect(detail.context).toMatchObject({ page: '/pay', role: 'admin' });
    expect(detail.context.secret).toBeUndefined();

    // Réponse de l'éditeur : l'auteur est prévenu.
    const answered = (
      await sa
        .post(`/platform/support/${ticket.id}/messages`, {
          body: 'Menu Rémunération, bouton Exporter : le fichier est prêt pour Orange Money.',
        })
        .expect(201)
    ).body;
    expect(answered).toMatchObject({
      status: 'answered',
      lastAuthor: 'platform',
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const notes = (await t.admin.api.get('/notifications').expect(200))
      .body as Body[];
    expect(notes.find((n) => n.type === 'support.reply')?.title).toContain(
      `#${ticket.number}`,
    );

    // La structure relance, puis ferme ; plus de message ensuite.
    const relance = (
      await t.admin.api
        .post(`/support/tickets/${ticket.id}/messages`, {
          body: 'Merci, c’est bon !',
        })
        .expect(201)
    ).body;
    expect(relance.status).toBe('open');
    expect(relance.messages.map((m: Body) => m.authorKind)).toEqual([
      'tenant',
      'platform',
      'tenant',
    ]);
    await t.admin.api.post(`/support/tickets/${ticket.id}/close`).expect(200);
    await t.admin.api
      .post(`/support/tickets/${ticket.id}/messages`, {
        body: 'Encore une chose',
      })
      .expect(409);
    await sa
      .patch(`/platform/support/${own.id}`, { status: 'closed' })
      .expect(200);
    const [audit] = await owner.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM platform_audit WHERE action LIKE 'support.%' AND tenant_id = $1`,
      [t.tenantId],
    );
    expect(audit.n).toBe(2);
  });

  it('documentation : réservée aux comptes connectés, selon le rôle, rédigée par l’éditeur', async () => {
    const t = await newTenant(app);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const sa = await platformApi();

    await new Api(app).get('/documentation').expect(401);
    const slugs = async (api: Api) =>
      ((await api.get('/documentation').expect(200)).body as Body[]).map(
        (a) => a.slug as string,
      );
    expect(await slugs(t.admin.api)).toEqual(
      expect.arrayContaining(['bienvenue', 'mettre-en-place', 'alertes']),
    );
    expect(await slugs(lead.api)).toContain('alertes');
    expect(await slugs(lead.api)).not.toContain('mettre-en-place');
    expect(await slugs(agent.api)).toEqual(['application-agent']);
    const article = (await lead.api.get('/documentation/alertes').expect(200))
      .body;
    expect(article.body).toContain('Je m’en occupe');
    await lead.api.get('/documentation/mettre-en-place').expect(404);

    // L'éditeur ajoute un article pour les chefs, puis le retire de la publication.
    const created = (
      await sa
        .post('/platform/documentation', {
          slug: 'astuces-chefs',
          section: 'Terrain',
          title: 'Astuces pour les chefs',
          body: '## Le matin\n\nOuvrez **Alertes** avant tout.',
          audience: ['team_lead'],
        })
        .expect(201)
    ).body;
    await sa
      .post('/platform/documentation', {
        slug: 'astuces-chefs',
        section: 'Terrain',
        title: 'Doublon',
        body: 'x',
        audience: ['admin'],
      })
      .expect(409);
    expect(await slugs(lead.api)).toContain('astuces-chefs');
    await sa
      .patch(`/platform/documentation/${created.id}`, { published: false })
      .expect(200);
    expect(await slugs(lead.api)).not.toContain('astuces-chefs');
    await sa.delete(`/platform/documentation/${created.id}`).expect(204);
    await sa.post('/platform/documentation/restore-defaults').expect(200);
  });
});

describe('Espace éditeur (super administrateur)', () => {
  const saEmail = () => uniqueEmail('sa');
  let sa: Api;
  let saId: string;

  /** Compte éditeur créé directement en base, comme le ferait le script d'installation. */
  async function platformLogin(email: string, password = 'Editeur2026!') {
    const res = await new Api(app)
      .post('/platform/auth/login', { email, password })
      .expect(200);
    return new Api(app, res.body.accessToken as string);
  }

  beforeAll(async () => {
    const email = saEmail();
    const [row] = await owner.query<{ id: string }[]>(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Serge', 'Aka') RETURNING id`,
      [email, await hashPassword('Editeur2026!')],
    );
    saId = row.id;
    sa = await platformLogin(email);
  });

  it('cloisonne les deux espaces : jeton éditeur et jeton de structure ne se mélangent pas', async () => {
    const t = await newTenant(app);
    await new Api(app)
      .post('/platform/auth/login', {
        email: t.admin.email,
        password: PASSWORD,
      })
      .expect(401);
    await new Api(app).get('/platform/dashboard').expect(401);
    await t.admin.api.get('/platform/dashboard').expect(401);
    await sa.get('/users').expect(401);
    await sa.get('/auth/me').expect(401);
    const me = (await sa.get('/platform/auth/me').expect(200)).body;
    expect(me.id).toBe(saId);
    expect(me.passwordHash).toBeUndefined();
  });

  it('verrouille la connexion après 5 échecs, même avec le bon mot de passe', async () => {
    const email = saEmail();
    await owner.query(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Test', 'Verrou')`,
      [email, await hashPassword('Editeur2026!')],
    );
    for (let i = 0; i < 5; i++)
      await new Api(app)
        .post('/platform/auth/login', { email, password: 'mauvais' })
        .expect(401);
    await new Api(app)
      .post('/platform/auth/login', { email, password: 'Editeur2026!' })
      .expect(429)
      .expect((r) => {
        expect(r.body.code).toBe('TOO_MANY_ATTEMPTS');
        expect(r.body.retryAfter).toBeGreaterThan(0);
      });
    // Les autres comptes ne sont pas bloqués.
    await new Api(app).get('/platform/auth/me').expect(401);
    expect((await sa.get('/platform/auth/me').expect(200)).body.id).toBe(saId);
  });

  it('crée une structure cliente, la retrouve et voit son détail', async () => {
    const adminEmail = uniqueEmail('client');
    const created = (
      await sa
        .post('/platform/tenants', {
          organizationName: 'Livraisons Bingerville',
          firstName: 'Mariam',
          lastName: 'Touré',
          email: adminEmail,
          password: 'Provisoire1',
          contactPhone: '07 55 44 33 22',
          planCode: 'base',
        })
        .expect(201)
    ).body;
    const tenantId = created.tenant.id as string;
    expect(created.tenant.contactPhone).toBe('+2250755443322');
    expect(created.subscription).toMatchObject({
      status: 'active',
      planCode: 'base',
      trialEndsAt: null,
    });
    expect(created.usage.agents).toMatchObject({ used: 0, limit: 10 });

    // L'administrateur de la structure se connecte avec le mot de passe provisoire.
    const client = (
      await new Api(app)
        .post('/auth/login', { email: adminEmail, password: 'Provisoire1' })
        .expect(200)
    ).body;
    const clientApi = new Api(app, client.accessToken as string);
    const sub = (await clientApi.get('/subscription').expect(200)).body;
    expect(sub.subscription.planCode).toBe('base');

    // Recherche par nom, par email et par numéro, filtres de statut et de formule.
    const find = async (query: string) =>
      (await sa.get(`/platform/tenants?${query}`).expect(200)).body;
    expect((await find('search=bingerville')).items).toHaveLength(1);
    expect((await find(`search=${adminEmail}`)).items).toHaveLength(1);
    expect((await find('search=0755443322')).items).toHaveLength(1);
    const listed = (
      await find('search=bingerville&status=active&planCode=base')
    ).items[0];
    expect(listed).toMatchObject({
      id: tenantId,
      planName: 'Base',
      mrr: 5000,
      agentLimit: 10,
      adminEmail,
    });
    expect(
      (await find('search=bingerville&status=trialing')).items,
    ).toHaveLength(0);

    await sa
      .patch(`/platform/tenants/${tenantId}`, {
        notes: 'Contrat signé le 2 octobre',
      })
      .expect(200);
    const detail = (await sa.get(`/platform/tenants/${tenantId}`).expect(200))
      .body;
    expect(detail.tenant.notes).toBe('Contrat signé le 2 octobre');
    expect(detail.admins).toHaveLength(1);
    expect(detail.activity).toHaveLength(30);
    expect(detail.estimate).toMatchObject({ basePrice: 5000 });
    expect(detail.history.map((h: Body) => h.action)).toEqual(
      expect.arrayContaining(['tenant.create', 'tenant.update']),
    );

    const dashboard = (await sa.get('/platform/dashboard').expect(200)).body;
    expect(dashboard.tenants.total).toBeGreaterThan(0);
    expect(dashboard.mrr).toBeGreaterThanOrEqual(5000);
    expect(dashboard.months).toHaveLength(12);
    expect(dashboard.byPlan.map((p: Body) => p.planCode)).toEqual([
      'base',
      'advanced',
      'enterprise',
    ]);
  });

  it('conditions négociées, essai prolongé, suspension manuelle et réactivation', async () => {
    const t = await newTenant(app);
    await t.createUser('agent');
    await t.createUser('agent');

    // Essai prolongé de 30 jours.
    const later = new Date(Date.now() + 30 * 86400_000).toISOString();
    const extended = (
      await sa
        .patch(`/platform/tenants/${t.tenantId}/subscription`, {
          trialEndsAt: later,
        })
        .expect(200)
    ).body;
    expect(new Date(extended.subscription.trialEndsAt).toISOString()).toBe(
      later,
    );
    expect(
      (await t.admin.api.get('/subscription').expect(200)).body.trialDaysLeft,
    ).toBe(30);

    // Quota négocié à 2 agents : la structure ne peut plus en ajouter.
    const custom = (
      await sa
        .patch(`/platform/tenants/${t.tenantId}/subscription`, {
          customIncludedAgents: 1,
          customMonthlyPrice: 12000,
        })
        .expect(200)
    ).body;
    expect(custom.warnings).toEqual(['2 agents actifs pour 1 autorisés']);
    await t.admin.api
      .post('/users', {
        email: uniqueEmail('agent'),
        password: PASSWORD,
        firstName: 'Trop',
        lastName: 'Agents',
        role: 'agent',
        phone: uniquePhone(),
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('QUOTA_EXCEEDED'));
    const estimate = (await t.admin.api.get('/subscription').expect(200)).body
      .estimate;
    expect(estimate.basePrice).toBe(12000);
    // La structure ne change pas seule de formule en gardant ses conditions.
    await t.admin.api
      .patch('/subscription', { planCode: 'enterprise' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('CUSTOM_TERMS'));
    // Retour aux conditions de la formule.
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, {
        customIncludedAgents: null,
        customMonthlyPrice: null,
      })
      .expect(200);

    // Suspension manuelle : la structure est coupée et prévenue ; la tâche ne la lève pas.
    await sa.post(`/platform/tenants/${t.tenantId}/suspend`, {}).expect(400);
    await sa
      .post(`/platform/tenants/${t.tenantId}/suspend`, {
        reason: 'Contrat résilié',
      })
      .expect(200)
      .expect((r) =>
        expect(r.body).toMatchObject({
          status: 'suspended',
          manualSuspension: true,
          suspensionReason: 'Contrat résilié',
        }),
      );
    await t.admin.api
      .get('/users')
      .expect(402)
      .expect((r) => expect(r.body.code).toBe('SUBSCRIPTION_SUSPENDED'));
    await jobs.subscriptions();
    await t.admin.api.get('/users').expect(402);
    const notes = (await t.admin.api.get('/notifications').expect(200)).body;
    expect(JSON.stringify(notes)).toContain('Contrat résilié');
    await sa
      .post(`/platform/tenants/${t.tenantId}/suspend`, { reason: 'Encore' })
      .expect(409);

    const back = (
      await sa.post(`/platform/tenants/${t.tenantId}/reactivate`).expect(200)
    ).body;
    // Toujours dans son essai prolongé.
    expect(back).toMatchObject({ status: 'trialing', manualSuspension: false });
    await t.admin.api.get('/users').expect(200);
    await sa.post(`/platform/tenants/${t.tenantId}/reactivate`).expect(409);

    // Hors essai, la fin d'essai ne se modifie plus.
    await owner.query(
      `UPDATE subscriptions SET status = 'active', trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, {
        trialEndsAt: later,
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('NOT_IN_TRIAL'));
    await sa.get(`/platform/tenants/${randomUUID()}`).expect(404);
  });

  it('enregistre un paiement hors plateforme, annule une facture, réactive la structure', async () => {
    const t = await newTenant(app, 'Impayés');
    const agent = await t.createUser('agent');
    const insert = (month: string, number: string) =>
      owner.query<{ id: string }[]>(
        `INSERT INTO invoices (tenant_id, number, month, plan_code, billing_cycle, agents, base_price,
                               amount, currency, status, issued_at, due_at)
         VALUES ($1, $2, $3, 'advanced', 'monthly', 1, 15000, 15000, 'XOF', 'pending',
                 now() - interval '40 days', now() - interval '20 days') RETURNING id`,
        [t.tenantId, number, month],
      );
    const [first] = await insert('2026-07-01', `F-TEST-${Date.now()}-1`);
    const [second] = await insert('2026-08-01', `F-TEST-${Date.now()}-2`);
    await owner.query(
      `UPDATE subscriptions SET status = 'active', trial_ends_at = now() - interval '60 days' WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await jobs.subscriptions();
    await agent.api.get('/days/current').expect(402);

    const overdue = (
      await sa
        .get(`/platform/invoices?tenantId=${t.tenantId}&overdue=true`)
        .expect(200)
    ).body;
    expect(overdue).toMatchObject({ total: 2, totalAmount: 30000 });
    expect(overdue.items[0]).toMatchObject({
      tenantName: 'Impayés',
      overdue: true,
    });
    expect(
      (
        await sa
          .get(`/platform/tenants?overdue=true&search=Impayés`)
          .expect(200)
      ).body.items[0].overdueAmount,
    ).toBe(30000);

    await sa
      .post(`/platform/invoices/${first.id}/payment`, { method: 'cheque' })
      .expect(400);
    const paid = (
      await sa
        .post(`/platform/invoices/${first.id}/payment`, {
          method: 'mobile_money',
          reference: 'OM-123456',
        })
        .expect(200)
    ).body;
    expect(paid.invoice).toMatchObject({
      status: 'paid',
      paymentMethod: 'mobile_money',
      paymentReference: 'OM-123456',
    });
    // Une facture échue reste : toujours suspendue.
    expect(paid.subscription.status).toBe('suspended');
    await sa
      .post(`/platform/invoices/${first.id}/payment`, { method: 'cash' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INVOICE_NOT_PENDING'));

    const voided = (
      await sa
        .post(`/platform/invoices/${second.id}/void`, {
          reason: 'Geste commercial',
        })
        .expect(200)
    ).body;
    expect(voided.invoice).toMatchObject({
      status: 'void',
      voidReason: 'Geste commercial',
    });
    expect(voided.subscription.status).toBe('active');
    await agent.api.get('/days/current').expect(200);

    // La structure voit le paiement enregistré dans ses factures, et en est prévenue.
    const invoices = (
      await t.admin.api.get('/subscription/invoices').expect(200)
    ).body;
    expect(invoices.find((i: Body) => i.id === first.id)).toMatchObject({
      status: 'paid',
    });
    const notes = (await t.admin.api.get('/notifications').expect(200)).body;
    expect(JSON.stringify(notes)).toContain('Paiement reçu');
    const audit = (
      await sa.get(`/platform/audit?tenantId=${t.tenantId}`).expect(200)
    ).body;
    expect(audit.items.map((a: Body) => a.action)).toEqual(
      expect.arrayContaining(['invoice.paid', 'invoice.void']),
    );
  });

  it('modifie le catalogue et les réglages de facturation', async () => {
    const plans = (await sa.get('/platform/plans').expect(200)).body;
    expect(plans.map((p: Body) => p.code)).toEqual([
      'base',
      'advanced',
      'enterprise',
    ]);
    const base = plans[0];
    await sa
      .patch('/platform/plans/base', { monthlyPrice: 6000, includedAgents: 12 })
      .expect(200)
      .expect((r) =>
        expect(r.body.plan).toMatchObject({
          monthlyPrice: 6000,
          includedAgents: 12,
        }),
      );
    await sa
      .patch('/platform/plans/base', {
        monthlyPrice: base.monthlyPrice,
        includedAgents: base.includedAgents,
      })
      .expect(200);
    await sa.patch('/platform/plans/inconnue', { monthlyPrice: 1 }).expect(404);

    const settings = (await sa.get('/platform/settings').expect(200)).body;
    await sa
      .patch('/platform/settings', { trialDays: 21 })
      .expect(200)
      .expect((r) => expect(r.body.trialDays).toBe(21));
    const t = await newTenant(app);
    expect(
      (await t.admin.api.get('/subscription').expect(200)).body.trialDaysLeft,
    ).toBe(21);
    await sa
      .patch('/platform/settings', { trialDays: settings.trialDays })
      .expect(200);
    await sa.patch('/platform/settings', { trialDays: 500 }).expect(400);
  });

  it('crée une formule et règle ses avantages : appliqués aussitôt aux structures', async () => {
    const t = await newTenant(app);
    const code = `pro-${Date.now() % 100000}`;
    await sa
      .post('/platform/plans', {
        code: 'Mauvais Code',
        name: 'X',
        description: '',
        monthlyPrice: 1,
        includedAgents: 1,
        includedLeads: 1,
        extraAgentPrice: 1,
        features: [],
      })
      .expect(400);
    await sa
      .post('/platform/plans', {
        code,
        name: 'Pro Statistiques',
        description: 'Statistiques sans missions',
        monthlyPrice: 25000,
        includedAgents: 20,
        includedLeads: 2,
        extraAgentPrice: 300,
        features: ['stats', 'inconnue'],
      })
      .expect(400);
    const created = (
      await sa
        .post('/platform/plans', {
          code,
          name: 'Pro Statistiques',
          description: 'Statistiques sans missions',
          monthlyPrice: 25000,
          includedAgents: 20,
          includedLeads: 2,
          extraAgentPrice: 300,
          features: ['stats', 'groups'],
        })
        .expect(201)
    ).body;
    expect(created).toMatchObject({
      code,
      isActive: true,
      features: ['stats', 'groups'],
    });
    await sa
      .post('/platform/plans', {
        ...created,
        createdAt: undefined,
        updatedAt: undefined,
      })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_CODE_TAKEN'));

    // La structure passe sur la nouvelle formule (hors essai) : ses avantages s'appliquent.
    await owner.query(
      `UPDATE subscriptions SET status = 'active', trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, { planCode: code })
      .expect(200);
    const me = (await t.admin.api.get('/auth/me').expect(200)).body;
    expect(me.subscription).toMatchObject({
      planCode: code,
      planName: 'Pro Statistiques',
    });
    expect(me.subscription.features.sort()).toEqual(['groups', 'stats']);
    expect(me.subscription.upgrades.missions).toEqual({
      code: 'advanced',
      name: 'Avancée',
    });
    await t.admin.api.get('/stats/overview').expect(200);
    await t.admin.api
      .get('/missions')
      .expect(402)
      .expect((r) =>
        expect(r.body).toMatchObject({
          requiredPlan: 'advanced',
          requiredPlanName: 'Avancée',
        }),
      );
    // Proposée aux structures dans leur page Abonnement, avec ses avantages.
    const offer = (await t.admin.api.get('/subscription').expect(200)).body;
    expect(offer.plans.find((p: Body) => p.code === code).features).toEqual([
      'groups',
      'stats',
    ]);

    // Avantage retiré : les structures le perdent aussitôt, et l'éditeur en est averti.
    await t.settings({ useGroups: true });
    const updated = (
      await sa
        .patch(`/platform/plans/${code}`, { features: ['groups', 'missions'] })
        .expect(200)
    ).body;
    expect(updated).toMatchObject({
      added: ['missions'],
      removed: ['stats'],
      affectedTenants: 1,
    });
    expect(updated.warnings).toHaveLength(1);
    await t.admin.api.get('/stats/overview').expect(402);
    await t.admin.api.get('/missions').expect(200);
    const withoutGroups = (
      await sa
        .patch(`/platform/plans/${code}`, { features: ['missions'] })
        .expect(200)
    ).body;
    expect(withoutGroups.warnings.join(' ')).toContain('groupes');

    // Formule utilisée : ni suppression, ni choix comme formule par défaut une fois retirée.
    await sa
      .delete(`/platform/plans/${code}`)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_IN_USE'));
    await sa.patch(`/platform/plans/${code}`, { isActive: false }).expect(200);
    await sa
      .patch('/platform/settings', { defaultPlanCode: code })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_UNAVAILABLE'));
    // Formule de l'essai et des nouvelles structures : protégées.
    await sa
      .patch('/platform/plans/advanced', { isActive: false })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('PLAN_USED_BY_SETTINGS'));

    // La structure repart sur une formule du catalogue ; la formule peut alors être supprimée.
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, {
        planCode: 'enterprise',
      })
      .expect(200);
    await sa.delete(`/platform/plans/${code}`).expect(204);
    await sa.delete(`/platform/plans/${code}`).expect(404);
    const audit = (await sa.get('/platform/audit').expect(200)).body;
    expect(audit.items.map((a: Body) => a.action)).toEqual(
      expect.arrayContaining(['plan.create', 'plan.update', 'plan.delete']),
    );
  });

  it('les avantages de la formule s’appliquent à la structure créée, et suivent ses changements', async () => {
    const adminEmail = uniqueEmail('base');
    const created = (
      await sa
        .post('/platform/tenants', {
          organizationName: 'Structure Base',
          firstName: 'Ali',
          lastName: 'Base',
          email: adminEmail,
          password: 'Provisoire1',
          planCode: 'base',
        })
        .expect(201)
    ).body;
    const tenantId = created.tenant.id as string;
    const admin = new Api(
      app,
      (
        await new Api(app)
          .post('/auth/login', { email: adminEmail, password: 'Provisoire1' })
          .expect(200)
      ).body.accessToken as string,
    );
    const me = (await admin.get('/auth/me').expect(200)).body;
    expect(me.subscription).toMatchObject({
      status: 'active',
      planCode: 'base',
      features: [],
    });

    // Chaque avantage absent de la formule est refusé par l'API.
    for (const [method, path, feature] of [
      ['post', '/groups', 'groups'],
      ['get', '/missions', 'missions'],
      ['get', '/stats/overview', 'stats'],
      ['get', '/team-leads', 'team_leads'],
      ['get', '/audit-logs', 'audit'],
      ['get', '/pay/current', 'payroll'],
      ['patch', '/branding', 'branding'],
    ] as const) {
      const res =
        method === 'get'
          ? await admin.get(path)
          : method === 'post'
            ? await admin.post(path, { name: 'X' })
            : await admin.patch(path, { primaryColor: '#0F766E' });
      expect([path, res.status, res.body.feature]).toEqual([
        path,
        402,
        feature,
      ]);
    }
    await admin
      .patch('/settings', { useGroups: true })
      .expect(402)
      .expect((r) => expect(r.body.requiredPlan).toBe('advanced'));
    await admin.patch('/settings', { approvalMode: 'manual' }).expect(402);

    // Réglages et apparence déjà en place (formule supérieure, puis rétrogradée) : neutralisés.
    await owner.query(
      `UPDATE tenant_settings SET use_groups = true, approval_mode = 'manual' WHERE tenant_id = $1`,
      [tenantId],
    );
    await owner.query(
      `UPDATE tenant_branding SET primary_color = '#0F766E', welcome_message = 'Bienvenue', version = 7 WHERE tenant_id = $1`,
      [tenantId],
    );
    const settings = (await admin.get('/auth/me').expect(200)).body.settings;
    expect(settings).toMatchObject({
      useGroups: false,
      approvalMode: 'automatic',
    });
    expect((await admin.get('/branding').expect(200)).body).toMatchObject({
      primaryColor: '#2563EB',
      welcomeMessage: null,
      logoUrl: null,
      version: 0,
    });
    // Validation des zones automatique, même si la structure l'avait réglée en manuel.
    const zone = await admin
      .post('/zones', { name: 'Plateau', area: PLATEAU })
      .expect(201);
    const phone = uniquePhone();
    const agentEmail = uniqueEmail('agent');
    await admin
      .post('/users', {
        email: agentEmail,
        password: PASSWORD,
        firstName: 'Agent',
        lastName: 'Base',
        role: 'agent',
        phone,
      })
      .expect(201);
    const agent = await login(app, agentEmail);
    expect(
      (await agent.post('/zone-requests', { zoneId: zone.body.id }).expect(201))
        .body.status,
    ).toBe('approved');

    // Formule supérieure : tout revient aussitôt, avec les réglages enregistrés.
    await sa
      .patch(`/platform/tenants/${tenantId}/subscription`, {
        planCode: 'enterprise',
      })
      .expect(200);
    const upgraded = (await admin.get('/auth/me').expect(200)).body;
    expect(upgraded.subscription.features).toHaveLength(10);
    expect(upgraded.settings).toMatchObject({
      useGroups: true,
      approvalMode: 'manual',
    });
    expect((await admin.get('/branding').expect(200)).body).toMatchObject({
      primaryColor: '#0F766E',
      welcomeMessage: 'Bienvenue',
      version: 7,
    });
    await admin.get('/stats/overview').expect(200);
    await admin.get('/pay/current').expect(200);
  });

  it('sans groupes, le chef d’équipe supervise toute la structure (formule Base)', async () => {
    const t = await newTenant(app);
    await owner.query(
      `UPDATE subscriptions SET status = 'active', plan_code = 'base', trial_ends_at = now() - interval '1 day'
       WHERE tenant_id = $1`,
      [t.tenantId],
    );
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, {
        planCode: 'base',
      })
      .expect(200);
    const lead = await t.createUser('team_lead');
    const a1 = await t.createUser('agent');
    const a2 = await t.createUser('agent');

    // Tous les agents, jamais les administrateurs ni les autres chefs.
    const users = (await lead.api.get('/users').expect(200)).body;
    expect(users.items.map((u: Body) => u.id).sort()).toEqual(
      [a1.id, a2.id].sort(),
    );
    await lead.api.get(`/users/${a2.id}`).expect(200);
    const stats = (await lead.api.get('/users/stats').expect(200)).body;
    expect(stats).toMatchObject({ agents: 2, admins: 0 });

    // Zones de la structure, journées et demandes de tous les agents.
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 5 });
    expect(
      (await lead.api.get('/zones').expect(200)).body.map((z: Body) => z.id),
    ).toContain(zone.id);
    await a1.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const requests = (await lead.api.get('/zone-requests').expect(200)).body;
    expect(requests.items.map((r: Body) => r.agent.id)).toContain(a1.id);
    expect((await lead.api.get('/live').expect(200)).body).toBeDefined();

    // Avec les groupes (formule Avancée), le chef revient à son seul groupe.
    await sa
      .patch(`/platform/tenants/${t.tenantId}/subscription`, {
        planCode: 'advanced',
      })
      .expect(200);
    await t.settings({ useGroups: true });
    await t.createGroup('Nord', lead.id, [a1.id], [zone.id]);
    const scoped = (await lead.api.get('/users').expect(200)).body;
    expect(scoped.items.map((u: Body) => u.id)).toEqual([a1.id]);
    await lead.api.get(`/users/${a2.id}`).expect(403);
  });

  it('fiche structure : comptes, groupes, terrain, configuration, journal et alertes, sans fuite', async () => {
    const t = await newTenant(app, 'Fiche complète');
    const other = await newTenant(app, 'Autre structure');
    await other.createUser('agent');
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent', { onProbation: true });
    await t.settings({ useGroups: true });
    const zone = await t.createZone('Plateau', PLATEAU, { capacity: 3 });
    await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);

    const users = (
      await sa.get(`/platform/tenants/${t.tenantId}/users`).expect(200)
    ).body;
    expect(users.items.map((u: Body) => u.role)).toEqual([
      'admin',
      'team_lead',
      'agent',
    ]);
    expect(users.summary).toMatchObject({
      admins: 1,
      leads: 1,
      agents: 1,
      active: 3,
    });
    expect(users.items[2]).toMatchObject({
      groupName: 'Nord',
      onProbation: true,
    });
    // Le chef s'est connecté (l'administrateur s'est seulement inscrit).
    expect(users.items[1].lastLoginAt).not.toBeNull();
    const agents = (
      await sa
        .get(`/platform/tenants/${t.tenantId}/users?role=agent&search=agent`)
        .expect(200)
    ).body;
    expect(agents.total).toBe(1);

    const groups = (
      await sa.get(`/platform/tenants/${t.tenantId}/groups`).expect(200)
    ).body;
    expect(groups).toEqual([
      expect.objectContaining({ name: 'Nord', agents: 1, zones: ['Plateau'] }),
    ]);

    const field = (
      await sa.get(`/platform/tenants/${t.tenantId}/field`).expect(200)
    ).body;
    expect(field.zones).toEqual([
      expect.objectContaining({
        name: 'Plateau',
        capacity: 3,
        area: expect.objectContaining({ type: 'Polygon' }),
      }),
    ]);
    expect(field.daily).toHaveLength(30);
    expect(JSON.stringify(field)).not.toMatch(/"lat"|"lng"|positions/);

    const config = (
      await sa.get(`/platform/tenants/${t.tenantId}/config`).expect(200)
    ).body;
    expect(config.settings.useGroups).toBe(true);
    expect(config.features.find((f: Body) => f.feature === 'groups')).toEqual({
      feature: 'groups',
      included: true,
      usage: '1 groupe',
    });

    const logins = (
      await sa
        .get(`/platform/tenants/${t.tenantId}/activity?kind=logins`)
        .expect(200)
    ).body;
    expect(logins.total).toBeGreaterThanOrEqual(2);
    expect(
      logins.items.every((l: Body) => l.action.startsWith('auth.login')),
    ).toBe(true);
    const changes = (
      await sa
        .get(`/platform/tenants/${t.tenantId}/activity?kind=changes`)
        .expect(200)
    ).body;
    expect(changes.items.length).toBeGreaterThan(0);

    // Alertes : aucune journée de travail depuis la création.
    const detail = (await sa.get(`/platform/tenants/${t.tenantId}`).expect(200))
      .body;
    expect(detail.alerts.map((a: Body) => a.code)).toContain('never_used');

    await sa.get(`/platform/tenants/${randomUUID()}/users`).expect(404);
    await sa.get(`/platform/tenants/${randomUUID()}/field`).expect(404);
  });

  it('formules de l’essai et des nouvelles structures réglables', async () => {
    await sa
      .patch('/platform/settings', {
        trialPlanCode: 'advanced',
        defaultPlanCode: 'base',
      })
      .expect(200);
    const t = await newTenant(app);
    const sub = (await t.admin.api.get('/subscription').expect(200)).body;
    expect(sub.subscription).toMatchObject({
      status: 'trialing',
      planCode: 'base',
    });
    // Essai : toutes les fonctionnalités, quotas de la formule d'essai.
    expect(sub.features).toHaveLength(10);
    expect(sub.usage.agents.limit).toBe(30);
    await sa
      .patch('/platform/settings', {
        trialPlanCode: 'enterprise',
        defaultPlanCode: 'advanced',
      })
      .expect(200);
    expect(
      (await t.admin.api.get('/subscription').expect(200)).body.usage.agents
        .limit,
    ).toBe(100);
  });

  it('double authentification : activation, connexion en deux étapes, secours, réinitialisation', async () => {
    const email = saEmail();
    const [row] = await owner.query<{ id: string }[]>(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Awa', 'Double') RETURNING id`,
      [email, await hashPassword('Editeur2026!')],
    );
    const awa = await platformLogin(email);
    expect(
      (await awa.get('/platform/auth/me').expect(200)).body.mfaEnabled,
    ).toBe(false);

    // Mise en place : QR code et secret, activés par un premier code juste.
    const setup = (await awa.post('/platform/auth/mfa/setup').expect(200)).body;
    expect(setup.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(setup.otpauthUrl).toContain(`secret=${setup.secret}`);
    // Pas de temps figé : le test ne dépend pas du passage d'une période de 30 s.
    const start = stepAt();
    const code = (offset = 0) => totp(setup.secret, start + offset);
    await awa.post('/platform/auth/mfa/enable', { code: '000000' }).expect(401);
    const enabled = (
      await awa.post('/platform/auth/mfa/enable', { code: code() }).expect(200)
    ).body;
    expect(enabled.recoveryCodes).toHaveLength(8);
    const stored = await owner.query<{ mfa_secret: string }[]>(
      `SELECT mfa_secret FROM platform_admins WHERE id = $1`,
      [row.id],
    );
    expect(stored[0].mfa_secret).not.toContain(setup.secret);
    await awa.post('/platform/auth/mfa/setup').expect(409);

    // Le mot de passe seul n'ouvre plus la session.
    const step1 = (
      await new Api(app)
        .post('/platform/auth/login', { email, password: 'Editeur2026!' })
        .expect(200)
    ).body;
    expect(step1).toMatchObject({ mfaRequired: true });
    expect(step1.accessToken).toBeUndefined();
    await new Api(app, step1.mfaToken).get('/platform/dashboard').expect(401);
    // Un code déjà utilisé ne ressert pas.
    await new Api(app)
      .post('/platform/auth/login/mfa', {
        mfaToken: step1.mfaToken,
        code: code(),
      })
      .expect(401)
      .expect((r) => expect(r.body.code).toBe('INVALID_MFA_CODE'));
    const session = (
      await new Api(app)
        .post('/platform/auth/login/mfa', {
          mfaToken: step1.mfaToken,
          code: code(1),
        })
        .expect(200)
    ).body;
    const awa2 = new Api(app, session.accessToken);
    expect(
      (await awa2.get('/platform/auth/me').expect(200)).body.mfaEnabled,
    ).toBe(true);
    await new Api(app)
      .post('/platform/auth/login/mfa', { mfaToken: 'faux', code: code() })
      .expect(401)
      .expect((r) => expect(r.body.code).toBe('MFA_SESSION_EXPIRED'));

    // Code de secours : valable une seule fois.
    const recovery = enabled.recoveryCodes[0] as string;
    const again = async () =>
      (
        await new Api(app)
          .post('/platform/auth/login', { email, password: 'Editeur2026!' })
          .expect(200)
      ).body.mfaToken as string;
    await new Api(app)
      .post('/platform/auth/login/mfa', {
        mfaToken: await again(),
        code: recovery.toUpperCase(),
      })
      .expect(200);
    await new Api(app)
      .post('/platform/auth/login/mfa', {
        mfaToken: await again(),
        code: recovery,
      })
      .expect(401);

    // Désactivation : mot de passe et code requis.
    await awa2
      .post('/platform/auth/mfa/disable', {
        password: 'mauvais',
        code: code(-1),
      })
      .expect(400);

    // Téléphone perdu : un autre compte réinitialise, jamais soi-même ; sessions coupées.
    await awa2.post(`/platform/admins/${row.id}/mfa-reset`).expect(409);
    await sa.post(`/platform/admins/${row.id}/mfa-reset`).expect(200);
    await awa2.get('/platform/auth/me').expect(401);
    const plain = (
      await new Api(app)
        .post('/platform/auth/login', { email, password: 'Editeur2026!' })
        .expect(200)
    ).body;
    expect(plain.accessToken).toBeDefined();

    // Obligatoire : sans 2FA, seule sa mise en place est accessible.
    process.env.PLATFORM_REQUIRE_MFA = 'true';
    try {
      const blocked = new Api(app, plain.accessToken);
      await blocked
        .get('/platform/dashboard')
        .expect(403)
        .expect((r) => expect(r.body.code).toBe('MFA_SETUP_REQUIRED'));
      expect(
        (await blocked.get('/platform/auth/me').expect(200)).body
          .mfaSetupRequired,
      ).toBe(true);
      const again2 = (
        await blocked.post('/platform/auth/mfa/setup').expect(200)
      ).body;
      const ready = (
        await blocked
          .post('/platform/auth/mfa/enable', {
            code: totp(again2.secret, stepAt()),
          })
          .expect(200)
      ).body;
      expect(ready.mfaSetupRequired).toBe(false);
      await new Api(app, ready.accessToken)
        .get('/platform/dashboard')
        .expect(200);
      await new Api(app, ready.accessToken)
        .post('/platform/auth/mfa/disable', {
          password: 'Editeur2026!',
          code: '123456',
        })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('MFA_REQUIRED'));
    } finally {
      delete process.env.PLATFORM_REQUIRE_MFA;
    }
    const audit = (await sa.get('/platform/audit').expect(200)).body;
    expect(audit.items.map((a: Body) => a.action)).toEqual(
      expect.arrayContaining([
        'auth.mfa_enabled',
        'auth.mfa_failed',
        'admin.mfa_reset',
      ]),
    );
  });

  it('gère les comptes de l’éditeur : création, mot de passe, désactivation', async () => {
    const email = saEmail();
    await sa
      .post('/platform/admins', {
        email,
        firstName: 'Nadia',
        lastName: 'Bamba',
        password: 'court',
      })
      .expect(400);
    const created = (
      await sa
        .post('/platform/admins', {
          email,
          firstName: 'Nadia',
          lastName: 'Bamba',
          password: 'Editeur2026!',
        })
        .expect(201)
    ).body;
    expect(created.passwordHash).toBeUndefined();
    await sa
      .post('/platform/admins', {
        email: email.toUpperCase(),
        firstName: 'X',
        lastName: 'Y',
        password: 'Editeur2026!',
      })
      .expect(409);

    // Nouveau mot de passe : l'ancien jeton est coupé, le nouveau fonctionne.
    const nadia = await platformLogin(email);
    const renewed = (
      await nadia
        .patch('/platform/auth/password', {
          currentPassword: 'Editeur2026!',
          newPassword: 'NouveauSecret2026',
        })
        .expect(200)
    ).body;
    await nadia.get('/platform/dashboard').expect(401);
    const nadia2 = new Api(app, renewed.accessToken as string);
    await nadia2.get('/platform/dashboard').expect(200);

    // Désactivé : session coupée, connexion refusée.
    await sa.patch(`/platform/admins/${saId}`, { isActive: false }).expect(409);
    await sa
      .patch(`/platform/admins/${created.id}`, { isActive: false })
      .expect(200);
    await nadia2.get('/platform/dashboard').expect(401);
    await new Api(app)
      .post('/platform/auth/login', { email, password: 'NouveauSecret2026' })
      .expect(401);

    const audit = (await sa.get('/platform/audit').expect(200)).body;
    expect(audit.items.map((a: Body) => a.action)).toEqual(
      expect.arrayContaining([
        'admin.create',
        'admin.disable',
        'auth.password',
        'auth.login_failed',
      ]),
    );
  });
});

describe('Onboarding de l’app mobile', () => {
  let sa: Api;

  beforeAll(async () => {
    const email = uniqueEmail('sa-onb');
    await owner.query(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Onboarding', 'Editeur')`,
      [email, await hashPassword('Editeur2026!')],
    );
    sa = new Api(
      app,
      (
        await new Api(app)
          .post('/platform/auth/login', { email, password: 'Editeur2026!' })
          .expect(200)
      ).body.accessToken as string,
    );
  });

  it('pages d’origine lues sans connexion, modifiées, réordonnées et republiées par l’éditeur', async () => {
    const anonymous = new Api(app);
    const pub = (await anonymous.get('/public/app-onboarding').expect(200))
      .body;
    expect(pub).toMatchObject({ enabled: true, version: 1 });
    expect(pub.slides.map((s: Body) => s.animation)).toEqual([
      'location',
      'missions',
      'team',
    ]);
    expect(pub.slides[0]).toMatchObject({ color: null, lottieUrl: null });

    let editor = (await sa.get('/platform/app-onboarding').expect(200)).body;
    const [first, second, third] = editor.slides as Body[];
    editor = (
      await sa
        .patch(`/platform/app-onboarding/slides/${first.id}`, {
          title: 'Bienvenue sur Suivi',
          color: '#0F766E',
        })
        .expect(200)
    ).body;
    expect(editor.slides[0]).toMatchObject({
      title: 'Bienvenue sur Suivi',
      color: '#0F766E',
    });
    await sa
      .patch(`/platform/app-onboarding/slides/${first.id}`, { color: 'rouge' })
      .expect(400);
    await sa
      .patch(`/platform/app-onboarding/slides/${first.id}`, {
        animation: 'fusee',
      })
      .expect(400);

    // Nouvelle page, puis ordre changé ; une page masquée n'est pas envoyée à l'app.
    editor = (
      await sa
        .post('/platform/app-onboarding/slides', {
          title: 'Votre paie',
          body: 'Suivez vos gains au jour le jour.',
          animation: 'missions',
        })
        .expect(201)
    ).body;
    const extra = editor.slides[3] as Body;
    await sa
      .put('/platform/app-onboarding/order', {
        ids: [third.id, first.id, second.id, extra.id],
      })
      .expect(200);
    await sa
      .put('/platform/app-onboarding/order', { ids: [third.id] })
      .expect(400);
    await sa
      .patch(`/platform/app-onboarding/slides/${extra.id}`, {
        isActive: false,
      })
      .expect(200);
    const reordered = (
      await anonymous.get('/public/app-onboarding').expect(200)
    ).body;
    expect(reordered.slides.map((s: Body) => s.id)).toEqual([
      third.id,
      first.id,
      second.id,
    ]);

    // Animation Lottie importée : vérifiée, servie, puis retirée.
    const upload = (id: string, buffer: Buffer, name: string) =>
      request(app.getHttpServer())
        .put(`/api/platform/app-onboarding/slides/${id}/lottie`)
        .set('Authorization', `Bearer ${sa.token}`)
        .attach('file', buffer, name);
    await upload(second.id, Buffer.from('pas du json'), 'x.json').expect(400);
    await upload(second.id, Buffer.from('{"a":1}'), 'x.json').expect(400);
    const lottie = {
      v: '5.7.4',
      fr: 30,
      ip: 0,
      op: 60,
      w: 200,
      h: 200,
      layers: [],
    };
    editor = (
      await upload(
        second.id,
        Buffer.from(JSON.stringify(lottie)),
        'carte.json',
      ).expect(200)
    ).body;
    const withLottie = (editor.slides as Body[]).find(
      (s) => s.id === second.id,
    )!;
    expect(withLottie).toMatchObject({ lottieName: 'carte.json' });
    const served = await anonymous
      .get(withLottie.lottieUrl.replace('/api', ''))
      .expect(200);
    expect(served.body).toEqual(lottie);
    expect(served.headers['cache-control']).toContain('immutable');
    await sa
      .delete(`/platform/app-onboarding/slides/${second.id}/lottie`)
      .expect(200);
    await anonymous.get(withLottie.lottieUrl.replace('/api', '')).expect(404);

    // Au moins une page affichée ; au plus six pages.
    for (const s of [first, second])
      await sa.delete(`/platform/app-onboarding/slides/${s.id}`).expect(200);
    await sa.delete(`/platform/app-onboarding/slides/${third.id}`).expect(400);
    await sa
      .patch(`/platform/app-onboarding/slides/${third.id}`, {
        isActive: false,
      })
      .expect(400);
    for (let i = 0; i < 4; i++)
      await sa
        .post('/platform/app-onboarding/slides', {
          title: `Page ${i}`,
          body: 'Texte de la page.',
          animation: 'team',
        })
        .expect(201);
    await sa
      .post('/platform/app-onboarding/slides', {
        title: 'Une de trop',
        body: 'Texte de la page.',
        animation: 'team',
      })
      .expect(400);

    // Nouvelle version : l'app le remontre ; désactivation ; pages d'origine.
    editor = (await sa.post('/platform/app-onboarding/republish').expect(200))
      .body;
    expect(editor.version).toBe(2);
    expect(editor.publishedAt).not.toBeNull();
    await sa.put('/platform/app-onboarding', { enabled: false }).expect(200);
    expect(
      (await anonymous.get('/public/app-onboarding').expect(200)).body,
    ).toMatchObject({ enabled: false, version: 2 });
    editor = (
      await sa.post('/platform/app-onboarding/restore-defaults').expect(200)
    ).body;
    expect(editor.slides).toHaveLength(3);

    // Réservé à l'éditeur ; journalisé.
    await anonymous.get('/platform/app-onboarding').expect(401);
    const t = await newTenant(app);
    await t.admin.api.get('/platform/app-onboarding').expect(401);
    const [{ n }] = await owner.query<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM platform_audit WHERE action LIKE 'app_onboarding.%'`,
    );
    expect(n).toBeGreaterThan(10);
  });
});

describe('Site vitrine modulable par l’éditeur', () => {
  let sa: Api;

  beforeAll(async () => {
    const email = uniqueEmail('sa-site');
    await owner.query(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       VALUES ($1, $2, 'Site', 'Editeur')`,
      [email, await hashPassword('Editeur2026!')],
    );
    sa = new Api(
      app,
      (
        await new Api(app)
          .post('/platform/auth/login', { email, password: 'Editeur2026!' })
          .expect(200)
      ).body.accessToken as string,
    );
  });

  it('publie le contenu modifié, avec les formules du catalogue', async () => {
    const pub = (await new Api(app).get('/public/landing').expect(200)).body;
    expect(pub.content.brand.name).toBe('Suivi Agent');
    expect(pub.plans.map((p: Body) => p.code)).toEqual([
      'base',
      'advanced',
      'enterprise',
    ]);
    expect(pub).toMatchObject({ currency: 'XOF', trialDays: 14 });

    const editor = (await sa.get('/platform/landing').expect(200)).body;
    expect(editor.hasChanges).toBe(false);
    const draft = editor.draft;

    // Contenu invalide : refusé, champ par champ.
    await sa
      .put('/platform/landing', {
        content: { ...draft, hero: { ...draft.hero, title: '' } },
      })
      .expect(400)
      .expect((r) => expect(r.body.message).toContain('hero.title'));
    await sa
      .put('/platform/landing', {
        content: {
          ...draft,
          sections: [...draft.sections, { id: 'x', type: 'video' }],
        },
      })
      .expect(400);
    await sa
      .put('/platform/landing', {
        content: {
          ...draft,
          hero: {
            ...draft.hero,
            primary: {
              label: 'Go',
              action: 'link',
              href: 'javascript:alert(1)',
            },
          },
        },
      })
      .expect(400);

    // Brouillon : invisible sur le site tant qu'il n'est pas publié.
    const sections = draft.sections.filter((s: Body) => s.type !== 'faq');
    sections.reverse();
    const saved = (
      await sa
        .put('/platform/landing', {
          content: {
            ...draft,
            brand: { ...draft.brand, name: 'Terrain Pro', extra: 'ignoré' },
            sections,
          },
        })
        .expect(200)
    ).body;
    expect(saved.hasChanges).toBe(true);
    expect(saved.draft.brand).toEqual({
      name: 'Terrain Pro',
      tagline: draft.brand.tagline,
    });
    expect(
      (await sa.get('/platform/landing/preview').expect(200)).body.content.brand
        .name,
    ).toBe('Terrain Pro');
    expect(
      (await new Api(app).get('/public/landing').expect(200)).body.content.brand
        .name,
    ).toBe('Suivi Agent');

    const published = (await sa.post('/platform/landing/publish').expect(200))
      .body;
    expect(published).toMatchObject({ hasChanges: false });
    const live = (await new Api(app).get('/public/landing').expect(200)).body
      .content;
    expect(live.brand.name).toBe('Terrain Pro');
    expect(live.sections.map((s: Body) => s.id)).toEqual(
      sections.map((s: Body) => s.id),
    );
    expect(live.sections.some((s: Body) => s.type === 'faq')).toBe(false);

    // Brouillon abandonné, puis contenu d'origine restauré (à publier).
    await sa
      .put('/platform/landing', {
        content: { ...live, brand: { ...live.brand, name: 'Autre' } },
      })
      .expect(200);
    expect(
      (await sa.delete('/platform/landing/draft').expect(200)).body.draft.brand
        .name,
    ).toBe('Terrain Pro');
    const restored = (
      await sa.post('/platform/landing/restore-defaults').expect(200)
    ).body;
    expect(restored.draft.brand.name).toBe('Suivi Agent');
    await sa.post('/platform/landing/publish').expect(200);

    // Formule retirée du catalogue : elle disparaît du site.
    await sa.patch('/platform/plans/base', { isActive: false }).expect(200);
    expect(
      (await new Api(app).get('/public/landing').expect(200)).body.plans.map(
        (p: Body) => p.code,
      ),
    ).toEqual(['advanced', 'enterprise']);
    await sa.patch('/platform/plans/base', { isActive: true }).expect(200);

    // Réservé à l'éditeur.
    const t = await newTenant(app);
    await t.admin.api.get('/platform/landing').expect(401);
    await new Api(app).put('/platform/landing', { content: draft }).expect(401);
  });

  it('images du site : envoi, utilisation, refus des fichiers qui ne sont pas des images', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = (buffer: Buffer, name: string) =>
      request(app.getHttpServer())
        .post('/api/platform/landing/assets')
        .set('Authorization', `Bearer ${sa.token}`)
        .attach('file', buffer, name);
    await upload(Buffer.from('<svg onload="alert(1)"/>'), 'x.svg').expect(400);
    const asset = (await upload(png, 'hero.png').expect(201)).body;
    const fetched = await new Api(app)
      .get(`/public/landing/assets/${asset.id}`)
      .expect(200);
    expect(fetched.headers['content-type']).toBe('image/png');
    expect(fetched.headers['cache-control']).toContain('immutable');

    const { draft } = (await sa.get('/platform/landing').expect(200)).body;
    await sa
      .put('/platform/landing', {
        content: {
          ...draft,
          hero: { ...draft.hero, visual: 'image', imageId: asset.id },
        },
      })
      .expect(200);
    await sa
      .put('/platform/landing', {
        content: {
          ...draft,
          hero: { ...draft.hero, visual: 'image', imageId: randomUUID() },
        },
      })
      .expect(400);
    await sa.delete('/platform/landing/draft').expect(200);
  });

  it('demandes de démo : envoi public, robots ignorés, limite, suivi par l’éditeur', async () => {
    const form = {
      name: 'Kouamé Yao',
      organization: 'Distribution Man',
      email: 'Kouame@Distrib.ci',
      phone: '07 11 22 33 44',
      agents: 25,
      message: 'Nous avons 3 équipes à Man.',
    };
    await new Api(app)
      .post('/public/demo-requests', { ...form, email: 'pas-un-email' })
      .expect(400);
    await new Api(app).post('/public/demo-requests', form).expect(201);
    // Robot (champ piège rempli) : réponse identique, rien d'enregistré.
    await new Api(app)
      .post('/public/demo-requests', { ...form, website: 'http://spam' })
      .expect(201);
    for (let i = 0; i < 4; i++)
      await new Api(app).post('/public/demo-requests', form).expect(201);
    await new Api(app)
      .post('/public/demo-requests', form)
      .expect(429)
      .expect((r) => expect(r.body.code).toBe('TOO_MANY_REQUESTS'));

    const list = (
      await sa.get('/platform/demo-requests?status=new').expect(200)
    ).body;
    expect(list.total).toBe(5);
    expect(list.items[0]).toMatchObject({
      organization: 'Distribution Man',
      email: 'kouame@distrib.ci',
      phone: '+2250711223344',
      agents: 25,
      status: 'new',
    });
    await sa
      .patch(`/platform/demo-requests/${list.items[0].id}`, {
        status: 'contacted',
        notes: 'Rappel jeudi',
      })
      .expect(200);
    const after = (await sa.get('/platform/demo-requests').expect(200)).body;
    expect(after.counts).toMatchObject({ new: 4, contacted: 1 });
    await sa
      .patch(`/platform/demo-requests/${randomUUID()}`, { status: 'won' })
      .expect(404);
  });
});

describe('Sorties de zone', () => {
  // Bord est du Plateau : longitude -4.01 ; 0,0009° ≈ 100 m à cette latitude.
  const east = (meters: number) => ({
    lat: 5.32,
    lng: -4.01 + meters / 110_840,
  });
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

  async function setup() {
    const t = await newTenant(app);
    await t.settings({
      useGroups: true,
      zoneExitToleranceMeters: 30,
      zoneExitAlertMinutes: 5,
    });
    const zone = await t.createZone('Plateau', PLATEAU);
    const lead = await t.createUser('team_lead');
    const agent = await t.createUser('agent');
    const other = await t.createUser('agent');
    await t.createGroup('Nord', lead.id, [agent.id], [zone.id]);
    await agent.api.post('/zone-requests', { zoneId: zone.id }).expect(201);
    const day = (await agent.api.post('/days/start').expect(200)).body;
    await owner.query(
      `UPDATE work_days SET started_at = now() - interval '2 hours' WHERE id = $1`,
      [day.id],
    );
    const send = (...points: object[]) =>
      agent.api.post('/positions/batch', { dayId: day.id, points }).expect(200);
    const exits = async () =>
      (await lead.api.get(`/days/${day.id}/zone-exits`).expect(200))
        .body as Body[];
    const alerts = async () =>
      ((await lead.api.get('/notifications').expect(200)).body as Body[])
        .filter((n) => String(n.type).startsWith('zone_exit'))
        .map((n) => n.type as string);
    return { t, zone, lead, agent, other, day, send, exits, alerts };
  }

  it('tolère la bordure et les points imprécis, alerte le chef après le délai puis au retour', async () => {
    const { t, agent, other, day, send, exits, alerts } = await setup();

    // 20 m dehors (dans la tolérance) ; 100 m dehors mais précis à 80 m : pas une sortie.
    await send(
      point(ago(40), east(20)),
      point(ago(39), east(100), { accuracy: 80 }),
    );
    expect(await exits()).toEqual([]);

    // Sortie franche, encore courte : enregistrée, chef pas encore prévenu.
    await send(point(ago(30), east(500)), point(ago(28), east(600)));
    let list = await exits();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ endedAt: null, alertedAt: null });
    expect(list[0].maxDistanceM).toBeGreaterThanOrEqual(590);
    expect(await alerts()).toEqual([]);

    // Toujours dehors après le délai : le chef est prévenu, la carte le montre.
    await send(point(ago(22), east(550)));
    list = await exits();
    expect(list[0].alertedAt).not.toBeNull();
    expect(await alerts()).toEqual(['zone_exit']);
    const live = (await t.admin.api.get('/live').expect(200)).body as Body[];
    expect(live[0].zoneExit).toMatchObject({ id: list[0].id, endedAt: null });

    // Retour près de la bordure (dans la tolérance) : sortie close, chef prévenu.
    await send(point(ago(20), east(25)));
    list = await exits();
    expect(list[0]).toMatchObject({ endReason: 'returned' });
    expect(await alerts()).toEqual(['zone_exit.returned', 'zone_exit']);
    expect(
      ((await t.admin.api.get('/live').expect(200)).body as Body[])[0].zoneExit,
    ).toBeNull();

    // L'agent voit ses sorties ; pas un autre agent.
    expect(
      (await agent.api.get(`/days/${day.id}/zone-exits`).expect(200)).body,
    ).toHaveLength(1);
    await other.api.get(`/days/${day.id}/zone-exits`).expect(404);
  });

  it('points reçus après une coupure : une seule alerte, sans annonce de retour ; sortie brève ignorée', async () => {
    const { send, exits, alerts } = await setup();
    await send(
      point(ago(60), east(400)),
      point(ago(50), east(800)),
      point(ago(45), IN_PLATEAU),
      // Sortie de 2 min : enregistrée, pas d'alerte.
      point(ago(30), east(300)),
      point(ago(28), IN_PLATEAU),
    );
    const list = await exits();
    expect(list.map((e) => [e.endReason, e.alertedAt !== null])).toEqual([
      ['returned', true],
      ['returned', false],
    ]);
    expect(await alerts()).toEqual(['zone_exit']);
  });

  it('le planificateur alerte sans nouvelle position ; la fin de journée et la réaffectation closent', async () => {
    const { t, lead, agent, day, send, exits, alerts } = await setup();
    await send(point(ago(3), east(500)));
    await jobs.everyMinute();
    expect(await alerts()).toEqual([]);

    await owner.query(
      `UPDATE zone_exits SET exited_at = now() - interval '6 minutes' WHERE day_id = $1`,
      [day.id],
    );
    await jobs.everyMinute();
    expect(await alerts()).toEqual(['zone_exit']);
    const body = (
      (await lead.api.get('/notifications').expect(200)).body as Body[]
    )[0];
    expect(body.body).toContain('Plateau');

    // Réaffectation : la sortie est close (la zone a changé).
    const cocody = await t.createZone('Cocody', COCODY);
    await t.admin.api
      .post('/zone-requests/reassign', { agentId: agent.id, zoneId: cocody.id })
      .expect(201);
    expect((await exits())[0]).toMatchObject({ endReason: 'zone_changed' });

    // Nouvelle sortie (hors de Cocody), puis fin de journée : close aussi.
    await send(point(ago(1), OUTSIDE));
    await agent.api.post('/days/end').expect(200);
    const list = await exits();
    expect(list).toHaveLength(2);
    expect(list[1]).toMatchObject({
      endReason: 'day_ended',
      zoneId: cocody.id,
    });
  });

  it('les réglages de tolérance et de délai sont bornés', async () => {
    const t = await newTenant(app);
    await t.admin.api
      .patch('/settings', { zoneExitToleranceMeters: 1000 })
      .expect(400);
    const saved = await t.admin.api
      .patch('/settings', {
        zoneExitToleranceMeters: 50,
        zoneExitAlertMinutes: 10,
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      zoneExitToleranceMeters: 50,
      zoneExitAlertMinutes: 10,
    });
  });
});
