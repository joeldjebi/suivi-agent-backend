/**
 * Activité de démonstration : 14 jours de terrain et la journée en cours, pour voir
 * le système « vivre » (carte en temps réel, itinéraires, historique, missions…).
 * Appelée par `npm run seed:demo`, après la création de la structure de démo.
 */
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { MISSION_ZONES_BACKFILL } from './mission-zones';

type Row = Record<string, string>;
type Box = [w: number, s: number, e: number, n: number];

interface Agent {
  id: string;
  first: string;
  last: string;
  groupId: string;
  zones: string[];
  /** Profil de comportement, pour des données variées */
  trait?: 'wanderer' | 'mocker' | 'forgetful';
}

interface Point {
  lat: number;
  lng: number;
  accuracy: number;
  speed: number;
  battery: number;
  mocked: boolean;
  at: string;
}

const DAYS_BACK = 14;
const MINUTE = 60_000;

/** Générateur pseudo-aléatoire reproductible (mêmes données à chaque lancement). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(2026);
const rand = (min: number, max: number) => min + rng() * (max - min);
const pick = <T>(list: T[]): T => list[Math.floor(rng() * list.length)];
const chance = (p: number) => rng() < p;

const NEW_ZONES: {
  name: string;
  box: Box;
  capacity: number | null;
  sensitive: boolean;
}[] = [
  {
    name: 'Adjamé',
    box: [-4.04, 5.34, -4.01, 5.37],
    capacity: 4,
    sensitive: false,
  },
  {
    name: 'Treichville',
    box: [-4.03, 5.29, -4.0, 5.305],
    capacity: 3,
    sensitive: false,
  },
  {
    name: 'Abobo',
    box: [-4.04, 5.4, -4.0, 5.44],
    capacity: 5,
    sensitive: true,
  },
  {
    name: 'Koumassi',
    box: [-3.955, 5.28, -3.92, 5.31],
    capacity: 3,
    sensitive: false,
  },
];

const COMMERCES = [
  'Boutique Awa',
  'Supérette Le Bon Prix',
  'Pharmacie du Marché',
  'Alimentation Konan',
  'Maquis Chez Tantie',
  'Quincaillerie Yao',
  'Cabine Orange Money',
  'Boulangerie La Paix',
  'Pressing Express',
  'Kiosque Wave',
  'Supermarché Prosuma',
  'Pharmacie des Lagunes',
  'Boutique Mariam',
  'Cosmétiques Belle',
  'Épicerie Bamba',
  'Librairie Savoir',
  'Restaurant Le Baobab',
  'Station Lavage Pro',
  'Couture Élégance',
  'Téléphonie Plus',
];
const REJECTIONS = [
  'Visite en double',
  'Commerce introuvable à cette adresse',
  'Montant incohérent avec la catégorie',
];

export async function generateActivity(
  ds: DataSource,
  tenantId: string,
  passwordHash: string,
) {
  const q = <T = Row>(sql: string, params: unknown[] = []) =>
    ds.query<T[]>(sql, params);

  const now = new Date();
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const dayMs = 24 * 3600 * 1000;
  const iso = (t: number) => new Date(t).toISOString();
  const dateOf = (t: number) => iso(t).slice(0, 10);

  // --- Organisation : zones, groupe Centre, agents supplémentaires ----------------------
  const boxes = new Map<string, Box>([
    ['Plateau', [-4.03, 5.31, -4.01, 5.33]],
    ['Cocody', [-4.0, 5.34, -3.96, 5.37]],
    ['Yopougon', [-4.1, 5.32, -4.06, 5.36]],
    ['Marcory', [-3.99, 5.29, -3.96, 5.31]],
  ]);
  const zoneIds = new Map<string, string>();
  for (const z of await q(`SELECT id, name FROM zones WHERE tenant_id = $1`, [
    tenantId,
  ]))
    zoneIds.set(z.name, z.id);
  for (const z of NEW_ZONES) {
    const [w, s, e, n] = z.box;
    const area = JSON.stringify({
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
    const [{ id }] = await q(
      `INSERT INTO zones (tenant_id, name, area, capacity, sensitive, created_at)
       VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5, $6) RETURNING id`,
      [
        tenantId,
        z.name,
        area,
        z.capacity,
        z.sensitive,
        iso(today - 30 * dayMs),
      ],
    );
    zoneIds.set(z.name, id);
    boxes.set(z.name, z.box);
  }
  const capacity = new Map(
    (
      await q(`SELECT id, capacity FROM zones WHERE tenant_id = $1`, [tenantId])
    ).map((z) => [z.id, z.capacity === null ? Infinity : Number(z.capacity)]),
  );

  const groups = new Map(
    (
      await q(`SELECT id, name, leader_id FROM groups WHERE tenant_id = $1`, [
        tenantId,
      ])
    ).map((g) => [g.name, g]),
  );
  const north = groups.get('Équipe Nord')!;
  const south = groups.get('Équipe Sud')!;
  await q(
    `INSERT INTO group_zones (group_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
    [south.id, zoneIds.get('Koumassi'), tenantId],
  );

  const [{ id: lead3 }] = await q(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, phone)
     VALUES ($1, 'chef3@demo.ci', $2, 'Christian', 'N''Guessan', 'team_lead', '+2250701010103') RETURNING id`,
    [tenantId, passwordHash],
  );
  const [{ id: centreId }] = await q(
    `INSERT INTO groups (tenant_id, name, leader_id) VALUES ($1, 'Équipe Centre', $2) RETURNING id`,
    [tenantId, lead3],
  );
  for (const name of ['Adjamé', 'Treichville', 'Abobo']) {
    await q(
      `INSERT INTO group_zones (group_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
      [centreId, zoneIds.get(name), tenantId],
    );
  }

  const extra: [string, string, string][] = [
    ['Jean-Marc', 'Aka', north.id],
    ['Mariam', 'Koné', north.id],
    ['Didier', 'Kouamé', south.id],
    ['Awa', 'Bamba', south.id],
    ['Paul', 'Yao', centreId],
    ['Rokia', 'Touré', centreId],
    ['Hervé', 'Konan', centreId],
    ['Esther', 'Gnahoré', centreId],
    ['Moussa', 'Sanogo', centreId],
    ['Clarisse', 'Ahoua', centreId],
  ];
  for (const [i, [first, last, groupId]] of extra.entries()) {
    const n = i + 7;
    await q(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, phone, group_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'agent', $6, $7, $8)`,
      [
        tenantId,
        `agent${n}@demo.ci`,
        passwordHash,
        first,
        last,
        `+22507020202${String(n).padStart(2, '0')}`,
        groupId,
        iso(today - 30 * dayMs),
      ],
    );
  }

  const groupZones = new Map<string, string[]>();
  for (const r of await q(
    `SELECT group_id, zone_id FROM group_zones WHERE tenant_id = $1`,
    [tenantId],
  )) {
    groupZones.set(r.group_id, [
      ...(groupZones.get(r.group_id) ?? []),
      r.zone_id,
    ]);
  }
  const traits: Record<string, Agent['trait']> = {
    Serge: 'wanderer',
    Ibrahim: 'mocker',
    Hervé: 'forgetful',
    Didier: 'wanderer',
  };
  const agents: Agent[] = (
    await q(
      `SELECT id, first_name, last_name, group_id FROM users WHERE tenant_id = $1 AND role = 'agent' ORDER BY phone`,
      [tenantId],
    )
  ).map((u) => ({
    id: u.id,
    first: u.first_name,
    last: u.last_name,
    groupId: u.group_id,
    zones: groupZones.get(u.group_id) ?? [],
    trait: traits[u.first_name],
  }));
  const zoneName = new Map([...zoneIds].map(([name, id]) => [id, name]));
  const homeZone = new Map(
    agents.map((a, i) => [a.id, a.zones[i % a.zones.length]]),
  );

  // --- Types de missions et missions ---------------------------------------------------
  const [prospection] = await q(
    `SELECT id FROM mission_types WHERE tenant_id = $1 AND name = 'Prospection'`,
    [tenantId],
  );
  const [{ id: collecteType }] = await q(
    `INSERT INTO mission_types (tenant_id, name, description, fields) VALUES ($1, 'Collecte', 'Encaissement auprès des clients', $2) RETURNING id`,
    [
      tenantId,
      JSON.stringify([
        { key: 'client', label: 'Client', type: 'text', required: true },
        {
          key: 'montant',
          label: 'Montant encaissé (FCFA)',
          type: 'number',
          required: true,
        },
        {
          key: 'paiement',
          label: 'Mode de paiement',
          type: 'select',
          required: true,
          options: ['Espèces', 'Mobile Money', 'Chèque'],
        },
      ]),
    ],
  );
  const [{ id: auditType }] = await q(
    `INSERT INTO mission_types (tenant_id, name, description, fields) VALUES ($1, 'Audit point de vente', 'Contrôle de la présentation des produits', $2) RETURNING id`,
    [
      tenantId,
      JSON.stringify([
        {
          key: 'point_de_vente',
          label: 'Point de vente',
          type: 'text',
          required: true,
        },
        {
          key: 'conforme',
          label: 'Présentation conforme',
          type: 'boolean',
          required: true,
        },
        {
          key: 'date_visite',
          label: 'Date de la visite',
          type: 'date',
          required: false,
        },
        { key: 'remarques', label: 'Remarques', type: 'text', required: false },
      ]),
    ],
  );

  const mission = async (m: {
    type: string;
    title: string;
    group?: string;
    agent?: string;
    method: 'count' | 'field_sum' | 'manual';
    target: number;
    sumKey?: string;
    createdDaysAgo: number;
    dueInDays: number;
    description?: string;
    /** Créateur : le chef du groupe, sinon l'administrateur */
    by?: string;
  }) => {
    const [{ id }] = await q(
      `INSERT INTO missions (tenant_id, type_id, title, description, assignee_group_id, assignee_agent_id, progress_method,
                             target_value, sum_field_key, due_date, created_at, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               coalesce($12::uuid, (SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' LIMIT 1)))
       RETURNING id`,
      [
        tenantId,
        m.type,
        m.title,
        m.description ?? null,
        m.group ?? null,
        m.agent ?? null,
        m.method,
        m.target,
        m.sumKey ?? null,
        iso(today + m.dueInDays * dayMs + 18 * 3600 * 1000),
        iso(today - m.createdDaysAgo * dayMs + 7 * 3600 * 1000),
        m.by ?? null,
      ],
    );
    return id;
  };
  const byName = (first: string) => agents.find((a) => a.first === first)!;

  const [{ id: northCurrent }] = await q(
    `SELECT id FROM missions WHERE tenant_id = $1 AND title = '50 visites cette semaine'`,
    [tenantId],
  );
  await q(
    `UPDATE missions SET title = '120 visites cette semaine', target_value = 120, created_at = $2, due_date = $3, description = $4 WHERE id = $1`,
    [
      northCurrent,
      iso(today - 5 * dayMs + 7 * 3600 * 1000),
      iso(today + 2 * dayMs + 18 * 3600 * 1000),
      'Présentez la nouvelle offre aux commerces de vos zones. Une visite = un formulaire.',
    ],
  );
  const plan = {
    northCurrent,
    northPast: await mission({
      type: prospection.id,
      title: 'Campagne de rentrée – 150 visites',
      by: north.leader_id,
      group: north.id,
      method: 'count',
      target: 150,
      createdDaysAgo: 14,
      dueInDays: -6,
    }),
    southCurrent: await mission({
      type: prospection.id,
      title: 'Prospection Sud – 120 visites',
      by: south.leader_id,
      group: south.id,
      method: 'count',
      target: 120,
      createdDaysAgo: 6,
      dueInDays: 4,
      description: 'Priorité aux supermarchés et pharmacies.',
    }),
    southPast: await mission({
      type: prospection.id,
      title: 'Lancement Mobile Money – 60 visites',
      group: south.id,
      method: 'count',
      target: 60,
      createdDaysAgo: 14,
      dueInDays: -3,
    }),
    centreCurrent: await mission({
      type: collecteType,
      title: 'Collecte 15 000 000 FCFA',
      by: lead3,
      group: centreId,
      method: 'field_sum',
      target: 15_000_000,
      sumKey: 'montant',
      createdDaysAgo: 6,
      dueInDays: 5,
    }),
    centrePast: await mission({
      type: collecteType,
      title: 'Collecte de septembre – 10 000 000 FCFA',
      group: centreId,
      method: 'field_sum',
      target: 10_000_000,
      sumKey: 'montant',
      createdDaysAgo: 14,
      dueInDays: -5,
    }),
    audit: await mission({
      type: auditType,
      title: 'Audit des pharmacies du Plateau',
      agent: byName('Aminata').id,
      method: 'manual',
      target: 1,
      createdDaysAgo: 10,
      dueInDays: 3,
    }),
    relance: await mission({
      type: prospection.id,
      title: 'Relance clients Cocody – 25 visites',
      agent: byName('Serge').id,
      method: 'count',
      target: 25,
      createdDaysAgo: 4,
      dueInDays: 3,
    }),
  };
  /** Mission sur laquelle un agent saisit ses formulaires, selon le jour. */
  const missionFor = (
    agent: Agent,
    daysAgo: number,
  ): { id: string; kind: 'prospection' | 'collecte' | 'audit' } => {
    if (agent.first === 'Aminata' && chance(0.25) && daysAgo <= 9)
      return { id: plan.audit, kind: 'audit' };
    if (agent.first === 'Serge' && chance(0.4) && daysAgo <= 3)
      return { id: plan.relance, kind: 'prospection' };
    if (agent.groupId === north.id)
      return {
        id: daysAgo >= 6 ? plan.northPast : plan.northCurrent,
        kind: 'prospection',
      };
    if (agent.groupId === south.id)
      return {
        id: daysAgo >= 6 ? plan.southPast : plan.southCurrent,
        kind: 'prospection',
      };
    return {
      id: daysAgo >= 6 ? plan.centrePast : plan.centreCurrent,
      kind: 'collecte',
    };
  };
  const formData = (kind: 'prospection' | 'collecte' | 'audit', at: number) => {
    if (kind === 'collecte') {
      return {
        client: pick(COMMERCES),
        montant: Math.round(rand(15, 160)) * 1000,
        paiement: pick(['Espèces', 'Mobile Money', 'Mobile Money', 'Chèque']),
      };
    }
    if (kind === 'audit') {
      return {
        point_de_vente: pick(
          COMMERCES.filter((c) => c.startsWith('Pharmacie')),
        ),
        conforme: chance(0.7),
        date_visite: dateOf(at),
        ...(chance(0.5) ? { remarques: 'Présentoir à réapprovisionner' } : {}),
      };
    }
    const interesse = chance(0.6);
    return {
      commerce: pick(COMMERCES),
      interesse,
      categorie: pick(['Boutique', 'Boutique', 'Supermarché', 'Pharmacie']),
      ...(interesse && chance(0.5)
        ? { montant: Math.round(rand(5, 80)) * 1000 }
        : {}),
    };
  };

  // --- Journées : itinéraires, pauses, demandes de zone, formulaires ------------------
  const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT ?? 6379),
  });
  await redis.del(`live:${tenantId}`);
  const stats = { days: 0, positions: 0, submissions: 0 };

  /** Itinéraire : marche aléatoire dans la zone, hors pauses, avec quelques coupures de signal. */
  const route = (
    agent: Agent,
    zone: Box,
    from: number,
    to: number,
    pauses: [number, number][],
    daySeed: { battery: number; outside: boolean; mocked: boolean },
  ) => {
    const [w, s, e, n] = zone;
    const inset = 0.12;
    let lat = rand(s + (n - s) * inset, n - (n - s) * inset);
    let lng = rand(w + (e - w) * inset, e - (e - w) * inset);
    let heading = rand(0, Math.PI * 2);
    let excursion = 0;
    let battery = daySeed.battery;
    const points: Point[] = [];
    for (let t = from; t <= to; t += rand(80, 150) * 1000) {
      if (pauses.some(([a, b]) => t >= a && t <= b)) continue;
      if (chance(0.004)) t += rand(8, 20) * MINUTE; // zone sans réseau ni GPS
      if (daySeed.outside && excursion === 0 && chance(0.01)) excursion = 18;
      heading += (rng() - 0.5) * 0.9;
      const step = rand(0.00008, 0.00035);
      lat += Math.cos(heading) * step;
      lng += Math.sin(heading) * step;
      const margin = excursion > 0 ? -0.004 : 0.0006;
      if (
        lat < s + margin ||
        lat > n - margin ||
        lng < w + margin ||
        lng > e - margin
      ) {
        heading =
          Math.atan2((w + e) / 2 - lng, (s + n) / 2 - lat) +
          (rng() - 0.5) * 0.6;
      }
      if (excursion > 0) {
        excursion--;
        if (excursion > 9) lat += 0.0006 * Math.sign(lat - (s + n) / 2 || 1);
      }
      battery = Math.max(0.08, battery - rand(0.0008, 0.0022));
      points.push({
        lat: Number(lat.toFixed(6)),
        lng: Number(lng.toFixed(6)),
        accuracy: Math.round(rand(4, 22)),
        speed: Number(rand(0, 1.6).toFixed(2)),
        battery: Number(battery.toFixed(2)),
        mocked: daySeed.mocked && chance(0.35),
        at: iso(t),
      });
    }
    return points;
  };

  const insertPositions = async (
    agentId: string,
    dayId: string,
    zoneId: string,
    points: Point[],
  ) => {
    for (let i = 0; i < points.length; i += 500) {
      await q(
        `INSERT INTO positions (tenant_id, agent_id, day_id, lat, lng, location, accuracy, speed, battery_level, is_mocked, outside_zone, recorded_at, received_at)
         SELECT $1, $2, $3, p.lat, p.lng, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), p.accuracy, p.speed, p.battery, p.mocked,
                NOT ST_Contains(z.area, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)), p.at, p.at
         FROM jsonb_to_recordset($4::jsonb) AS p(lat float8, lng float8, accuracy float4, speed float4, battery float4, mocked boolean, at timestamptz)
         JOIN zones z ON z.id = $5
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          agentId,
          dayId,
          JSON.stringify(points.slice(i, i + 500)),
          zoneId,
        ],
      );
    }
    stats.positions += points.length;
  };

  const notify = (
    userId: string,
    type: string,
    title: string,
    body: string,
    at: number,
    read: boolean,
    data: object = {},
  ) =>
    q(
      `INSERT INTO notifications (tenant_id, user_id, type, title, body, data, created_at, read_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        tenantId,
        userId,
        type,
        title,
        body,
        JSON.stringify(data),
        iso(at),
        read ? iso(at + 30 * MINUTE) : null,
      ],
    );

  const leaderOf = new Map([
    [north.id, north.leader_id],
    [south.id, south.leader_id],
    [centreId, lead3],
  ]);

  // Scénarios d'aujourd'hui (un par agent, dans l'ordre des numéros).
  const todayScenario = new Map<
    string,
    'active' | 'paused' | 'lost' | 'outside' | 'mocked' | 'ready' | 'pending'
  >();
  const scenarios = [
    'active',
    'active',
    'outside',
    'active',
    'mocked',
    'paused',
    'active',
    'pending',
    'active',
    'lost',
    'active',
    'paused',
    'active',
    'active',
    'ready',
    'active',
  ] as const;
  agents.forEach((a, i) =>
    todayScenario.set(a.id, scenarios[i % scenarios.length]),
  );

  // Trois profils de chef : réactif, correct, lent (demandes parfois sans réponse).
  const leaderProfile = new Map([
    [north.leader_id, { min: 3, max: 12, miss: 0, login: 0.95 }],
    [south.leader_id, { min: 8, max: 35, miss: 0.05, login: 0.85 }],
    [lead3, { min: 20, max: 95, miss: 0.3, login: 0.55 }],
  ]);

  for (let daysAgo = DAYS_BACK; daysAgo >= 0; daysAgo--) {
    const base = today - daysAgo * dayMs;
    const weekday = new Date(base).getUTCDay();
    if (weekday === 0 && daysAgo > 0) continue; // dimanche : repos
    const seats = new Map<string, number>();

    for (const [leaderId, profile] of leaderProfile) {
      const at = base + (7 * 60 + 10 + rand(0, 40)) * MINUTE;
      if (chance(profile.login) && at < now.getTime()) {
        await q(
          `INSERT INTO audit_logs (tenant_id, user_id, action, ip, created_at) VALUES ($1, $2, 'auth.login', '41.207.10.30', $3)`,
          [tenantId, leaderId, iso(at)],
        );
      }
    }

    for (const agent of agents) {
      const isToday = daysAgo === 0;
      const scenario = todayScenario.get(agent.id)!;
      if (!isToday && !chance(0.88)) continue; // absence
      if (weekday === 6 && !chance(0.4)) continue; // samedi : demi-équipe

      // Zone : la zone habituelle, parfois une autre ; jamais au-delà de la capacité.
      let zoneId = chance(0.8) ? homeZone.get(agent.id)! : pick(agent.zones);
      if ((seats.get(zoneId) ?? 0) >= (capacity.get(zoneId) ?? Infinity)) {
        zoneId =
          agent.zones.find(
            (z) => (seats.get(z) ?? 0) < (capacity.get(z) ?? Infinity),
          ) ?? zoneId;
      }
      seats.set(zoneId, (seats.get(zoneId) ?? 0) + 1);
      const box = boxes.get(zoneName.get(zoneId)!)!;

      let start = base + (7 * 60 + 40 + rand(0, 50)) * MINUTE;
      if (isToday && now.getTime() < start + 90 * MINUTE)
        start = now.getTime() - rand(100, 160) * MINUTE;
      const workDate = dateOf(base);

      // Demande refusée puis nouvelle demande, de temps en temps.
      if (chance(0.06) && !isToday) {
        const other = agent.zones.find((z) => z !== zoneId) ?? zoneId;
        await q(
          `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, expires_at, decided_by_id, decided_at, decision_reason, released_at, release_reason, created_at)
           VALUES ($1, $2, $3, 'rejected', true, $4, $5, $6, $5, 'Zone déjà couverte aujourd''hui', $5, 'rejected', $7)`,
          [
            tenantId,
            agent.id,
            other,
            workDate,
            iso(start - 40 * MINUTE),
            leaderOf.get(agent.groupId),
            iso(start - 50 * MINUTE),
          ],
        );
        await notify(
          agent.id,
          'zone_request.rejected',
          'Demande de zone refusée',
          `Zone ${zoneName.get(other)} : zone déjà couverte aujourd'hui`,
          start - 40 * MINUTE,
          true,
        );
      }

      if (isToday && scenario === 'pending') {
        const [{ id: requestId }] = await q(
          `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, expires_at, created_at)
           VALUES ($1, $2, $3, 'pending', true, $4, $5, $6) RETURNING id`,
          [
            tenantId,
            agent.id,
            zoneId,
            workDate,
            iso(now.getTime() + 22 * MINUTE),
            iso(now.getTime() - 8 * MINUTE),
          ],
        );
        await notify(
          leaderOf.get(agent.groupId)!,
          'zone_request.created',
          'Demande de zone à approuver',
          `${agent.first} ${agent.last} demande la zone ${zoneName.get(zoneId)}`,
          now.getTime() - 8 * MINUTE,
          false,
          { requestId },
        );
        continue;
      }
      const leaderId = leaderOf.get(agent.groupId)!;
      const profile = leaderProfile.get(leaderId)!;
      if (!isToday && chance(0.3)) {
        // Zone soumise à validation : le chef répond plus ou moins vite, ou pas du tout.
        const missed = chance(profile.miss);
        const response =
          (missed ? 30 : rand(profile.min, profile.max)) * MINUTE;
        const created = start - response - 10 * MINUTE;
        await q(
          `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, expires_at,
                                      decided_by_id, decided_at, decision_reason, released_at, release_reason, created_at)
           VALUES ($1, $2, $3, 'released', true, $4, $5, $6, $7, $8, $9, 'day_ended', $10)`,
          [
            tenantId,
            agent.id,
            zoneId,
            workDate,
            iso(created + 30 * MINUTE),
            missed ? null : leaderId,
            iso(created + response),
            missed ? 'expired_auto_approved' : null,
            iso(base + 18 * 3600 * 1000),
            iso(created),
          ],
        );
      } else {
        await q(
          `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, decided_at, decision_reason, released_at, release_reason, created_at)
           VALUES ($1, $2, $3, $4, false, $5, $6, 'auto', $7, $8, $6)`,
          [
            tenantId,
            agent.id,
            zoneId,
            isToday ? 'approved' : 'released',
            workDate,
            iso(start - 15 * MINUTE),
            isToday ? null : iso(base + 18 * 3600 * 1000),
            isToday ? null : 'day_ended',
          ],
        );
      }
      // Changement de zone imposé par le chef, de temps en temps.
      if (!isToday && chance(0.025)) {
        const other = agent.zones.find((z) => z !== zoneId);
        if (other) {
          await q(
            `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, is_change,
                                        decided_by_id, decided_at, decision_reason, released_at, release_reason, created_at)
             VALUES ($1, $2, $3, 'released', false, $4, true, $5, $6, 'reassigned', $7, 'day_ended', $6)`,
            [
              tenantId,
              agent.id,
              other,
              workDate,
              leaderId,
              iso(base + 11 * 3600 * 1000),
              iso(base + 18 * 3600 * 1000),
            ],
          );
        }
      }
      await q(
        `INSERT INTO audit_logs (tenant_id, user_id, action, ip, created_at) VALUES ($1, $2, 'auth.login', '41.207.10.12', $3)`,
        [tenantId, agent.id, iso(start - 20 * MINUTE)],
      );
      if (isToday && scenario === 'ready') continue;

      // Pauses : déjeuner, parfois une courte pause l'après-midi.
      const lunch = base + (12 * 60 + 15 + rand(0, 40)) * MINUTE;
      const pauses: [number, number][] = [
        [lunch, lunch + rand(30, 60) * MINUTE],
      ];
      if (chance(0.25)) {
        const p = base + (15 * 60 + 30 + rand(0, 30)) * MINUTE;
        pauses.push([p, p + rand(10, 15) * MINUTE]);
      }

      let end = base + (16 * 60 + 30 + rand(0, 90)) * MINUTE;
      let endReason: string | null = 'manual';
      let status = 'ended';
      let trackUntil = end;
      if (agent.trait === 'forgetful' && chance(0.4) && !isToday) {
        end = base + dayMs; // journée oubliée : terminée à la remise à zéro
        endReason = 'auto_reset';
        trackUntil = base + (18 * 60 + rand(0, 30)) * MINUTE; // téléphone éteint en rentrant
      }
      let currentPause: [number, number] | null = null;
      if (isToday) {
        status = 'active';
        endReason = null;
        trackUntil = now.getTime() - rand(20, 70) * 1000;
        // Pauses déjà terminées seulement ; une pause en cours pour le scénario « pause ».
        for (let i = pauses.length - 1; i >= 0; i--)
          if (pauses[i][0] > now.getTime()) pauses.splice(i, 1);
        for (const p of pauses)
          if (p[1] > now.getTime()) p[1] = now.getTime() - 2 * MINUTE;
        if (scenario === 'paused') {
          currentPause = [now.getTime() - rand(8, 20) * MINUTE, now.getTime()];
          status = 'paused';
        }
        if (scenario === 'lost')
          trackUntil = now.getTime() - rand(22, 35) * MINUTE;
      }

      const points = route(
        agent,
        box,
        start,
        currentPause ? currentPause[0] : trackUntil,
        pauses,
        {
          battery: rand(0.82, 1),
          outside:
            agent.trait === 'wanderer' || (isToday && scenario === 'outside'),
          mocked:
            (agent.trait === 'mocker' && chance(0.3) && !isToday) ||
            (isToday && scenario === 'mocked'),
        },
      );
      if (isToday && scenario === 'outside' && points.length) {
        // Dernières positions franchement hors de la zone.
        const last = points[points.length - 1];
        for (let k = 0; k < 6; k++) {
          points.push({
            ...last,
            lat: Number((box[3] + 0.004 + k * 0.0004).toFixed(6)),
            at: iso(Date.parse(last.at) + (k + 1) * 15_000),
          });
        }
        points.sort((a, b) => a.at.localeCompare(b.at));
        points.splice(
          0,
          points.length,
          ...points.filter((p) => Date.parse(p.at) < now.getTime()),
        );
      }

      const [{ id: dayId }] = await q(
        `INSERT INTO work_days (tenant_id, agent_id, zone_id, status, work_date, started_at, ended_at, end_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6) RETURNING id`,
        [
          tenantId,
          agent.id,
          zoneId,
          status,
          workDate,
          iso(start),
          isToday ? null : iso(end),
          endReason,
        ],
      );
      for (const [a, b] of pauses) {
        await q(
          `INSERT INTO day_pauses (tenant_id, day_id, started_at, ended_at) VALUES ($1, $2, $3, $4)`,
          [tenantId, dayId, iso(a), iso(b)],
        );
      }
      if (currentPause) {
        await q(
          `INSERT INTO day_pauses (tenant_id, day_id, started_at) VALUES ($1, $2, $3)`,
          [tenantId, dayId, iso(currentPause[0])],
        );
      }
      await insertPositions(agent.id, dayId, zoneId, points);
      stats.days++;

      // Formulaires saisis le long de l'itinéraire.
      const forms = isToday ? Math.floor(rand(1, 4)) : Math.floor(rand(2, 7));
      for (let k = 0; k < forms && points.length > 10; k++) {
        const p = points[Math.floor(rand(5, points.length - 1))];
        const target = missionFor(agent, daysAgo);
        const rejected = chance(0.03);
        await q(
          `INSERT INTO mission_submissions (tenant_id, mission_id, agent_id, day_id, client_id, data, lat, lng, submitted_at, received_at, status, rejected_reason, rejected_by_id, rejected_at)
           VALUES ($1, $2, $3, $4, gen_random_uuid(), $5, $6, $7, $8, $8, $9, $10, $11,
                   CASE WHEN $9 = 'rejected' THEN $8::timestamptz + interval '2 hours' END)`,
          [
            tenantId,
            target.id,
            agent.id,
            dayId,
            JSON.stringify(formData(target.kind, Date.parse(p.at))),
            p.lat,
            p.lng,
            p.at,
            rejected ? 'rejected' : 'accepted',
            rejected ? pick(REJECTIONS) : null,
            rejected ? leaderOf.get(agent.groupId) : null,
          ],
        );
        if (rejected) {
          await notify(
            agent.id,
            'submission.rejected',
            'Formulaire rejeté',
            pick(REJECTIONS),
            Date.parse(p.at) + 3 * 3600 * 1000,
            daysAgo > 1,
          );
        }
        stats.submissions++;
      }

      // Carte en temps réel : dernière position des journées en cours.
      if (isToday && points.length) {
        const last = points[points.length - 1];
        const [w, s, e, n] = box;
        await redis.hset(
          `live:${tenantId}`,
          agent.id,
          JSON.stringify({
            agentId: agent.id,
            dayId,
            zoneId,
            status,
            lat: last.lat,
            lng: last.lng,
            accuracy: last.accuracy,
            batteryLevel: last.battery,
            isMocked: points.slice(-10).some((pt) => pt.mocked),
            outsideZone:
              last.lat < s || last.lat > n || last.lng < w || last.lng > e,
            recordedAt: last.at,
            receivedAt: last.at,
          }),
        );
      }
    }
  }
  await redis.quit();

  // --- Résultats des missions --------------------------------------------------------
  await q(`UPDATE missions SET status = 'achieved' WHERE id = $1`, [
    plan.audit,
  ]);
  await q(
    `UPDATE missions m SET status = CASE
        WHEN p.value >= m.target_value THEN 'achieved'
        WHEN m.due_date < now() THEN 'failed'
        WHEN p.value > 0 THEN 'in_progress'
        ELSE 'todo' END
     FROM (
       SELECT m2.id, coalesce(
         CASE WHEN m2.progress_method = 'count' THEN count(s.id)::numeric
              ELSE sum((s.data ->> m2.sum_field_key)::numeric) END, 0) AS value
       FROM missions m2 LEFT JOIN mission_submissions s ON s.mission_id = m2.id AND s.status = 'accepted'
       WHERE m2.tenant_id = $1 AND m2.progress_method <> 'manual'
       GROUP BY m2.id
     ) p
     WHERE p.id = m.id`,
    [tenantId],
  );
  for (const agent of agents) {
    await notify(
      agent.id,
      'mission.assigned',
      'Nouvelle mission',
      'Une nouvelle mission vous a été confiée',
      today - 5 * dayMs + 7 * 3600 * 1000,
      true,
    );
  }

  for (const sql of MISSION_ZONES_BACKFILL) await q(sql, [tenantId]);
  return { ...stats, agents: agents.length };
}
