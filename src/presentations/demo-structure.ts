import type { EntityManager } from 'typeorm';
import type Redis from 'ioredis';
import type { PresentationContent } from './presentations.service';

/**
 * Structure de démonstration d'un client, créée depuis sa présentation : son nom, sa couleur,
 * ses quartiers, ses produits et une équipe à sa taille (plafonnée), avec 6 jours d'activité
 * (journées, itinéraires, formulaires) et la journée en cours visible sur la carte en direct.
 * Les comptes sont propres à cette structure (e-mails et numéros générés, jamais réels).
 */

type Box = [w: number, s: number, e: number, n: number];
type Row = Record<string, string>;

/** Communes d'Abidjan (périmètres simplifiés), reconnues par leur nom. */
const KNOWN: Record<string, Box> = {
  plateau: [-4.03, 5.31, -4.01, 5.33],
  cocody: [-4.0, 5.34, -3.96, 5.37],
  yopougon: [-4.1, 5.32, -4.06, 5.36],
  marcory: [-3.988, 5.285, -3.962, 5.304],
  koumassi: [-3.958, 5.285, -3.93, 5.305],
  treichville: [-4.012, 5.29, -3.992, 5.305],
  adjame: [-4.04, 5.345, -4.015, 5.37],
  abobo: [-4.04, 5.4, -4.0, 5.44],
  angre: [-3.995, 5.38, -3.96, 5.405],
  'cocody angre': [-3.995, 5.38, -3.96, 5.405],
  riviera: [-3.985, 5.34, -3.95, 5.37],
  'cocody riviera': [-3.985, 5.34, -3.95, 5.37],
  'deux plateaux': [-4.0, 5.36, -3.98, 5.38],
  attecoube: [-4.06, 5.33, -4.035, 5.355],
  'port bouet': [-3.95, 5.24, -3.9, 5.27],
  bingerville: [-3.9, 5.34, -3.87, 5.37],
  anyama: [-4.06, 5.48, -4.03, 5.51],
};
const DEFAULT_AREAS = ['Plateau', 'Cocody', 'Yopougon', 'Marcory'];

const FIRST = [
  'Awa',
  'Serge',
  'Aminata',
  'Jean-Marc',
  'Mariam',
  'Didier',
  'Fatou',
  'Hervé',
  'Rokia',
  'Ibrahim',
  'Nadia',
  'Paul',
  'Esther',
  'Moussa',
  'Clarisse',
];
const LAST = [
  'Koné',
  'Gnagne',
  'Diallo',
  'Aka',
  'Bamba',
  'Kipré',
  'Ouattara',
  'Yao',
  'Touré',
  'Coulibaly',
  'Yapi',
  'Konan',
  'Gnahoré',
  'Sanogo',
  'Ahoua',
];
const LEADS: [string, string][] = [
  ['Yao', 'Kouassi'],
  ['Christian', 'N’Guessan'],
  ['Adjoua', 'Kouadio'],
];
const COMMERCES = [
  'Boutique Awa',
  'Supérette Le Bon Prix',
  'Maquis Chez Tantie',
  'Alimentation Konan',
  'Boutique Mariam',
  'Épicerie Bamba',
  'Supérette La Paix',
  'Maquis Le Baobab',
  'Kiosque du Carrefour',
  'Alimentation Yao',
  'Boutique Fatou',
  'Supérette Étoile',
];
const CATEGORIES = ['Boutique', 'Maquis', 'Supérette'];

const VISIT_FORM = [
  { key: 'commerce', label: 'Nom du commerce', type: 'text', required: true },
  {
    key: 'categorie',
    label: 'Catégorie',
    type: 'select',
    required: true,
    options: CATEGORIES,
  },
  {
    key: 'interesse',
    label: 'Client intéressé',
    type: 'boolean',
    required: true,
  },
  {
    key: 'montant',
    label: 'Montant de la commande (FCFA)',
    type: 'number',
    required: false,
  },
];

const MINUTE = 60_000;
const DAY = 24 * 3600 * 1000;
const DAYS_BACK = 6;

/** Générateur reproductible par structure (graine tirée de son identifiant). */
function random(seed: number) {
  let s = seed | 0;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    rand: (min: number, max: number) => min + next() * (max - min),
    chance: (p: number) => next() < p,
    pick: <T>(list: T[]) => list[Math.floor(next() * list.length)],
  };
}

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const polygon = ([w, s, e, n]: Box) =>
  JSON.stringify({
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

/** Quartiers du client : périmètre connu, sinon une case libre au nord d'Abidjan (à ajuster). */
export function demoZones(areas: string[]): { name: string; box: Box }[] {
  const names = (areas.length ? areas : DEFAULT_AREAS).slice(0, 6);
  let free = 0;
  return names.map((name) => {
    const known = KNOWN[normalize(name)];
    if (known) return { name, box: known };
    const w = -4.12 + (free++ % 4) * 0.035;
    return { name, box: [w, 5.45, w + 0.025, 5.475] };
  });
}

export interface DemoAccount {
  role: 'admin' | 'team_lead' | 'agent';
  name: string;
  email: string;
  phone: string | null;
  group: string | null;
}

export interface DemoInput {
  tenantId: string;
  code: string;
  content: PresentationContent;
  passwordHash: string;
  /** Début des numéros (« 0798 » + 4 chiffres), libre de tout compte existant */
  phoneBlock: string;
}

/** Comptes prévus : un administrateur, des chefs (1 à 3), des agents (4 à 12). */
export function demoAccounts(
  content: PresentationContent,
  code: string,
  phoneBlock: string,
): DemoAccount[] {
  const leads = Math.max(1, Math.min(3, content.leads || 1));
  const agents = Math.max(4, Math.min(12, content.agents || 4));
  const teams = Array.from({ length: leads }, (_, i) =>
    leads === 1 ? 'Équipe terrain' : `Équipe ${['Nord', 'Sud', 'Centre'][i]}`,
  );
  const mail = (tag: string) => `${tag}.${code}@demo.performx.online`;
  let n = 1;
  const phone = () => `+225${phoneBlock}${String(n++).padStart(2, '0')}`;
  const accounts: DemoAccount[] = [
    {
      role: 'admin',
      name: `Responsable ${content.clientName}`.slice(0, 80),
      email: mail('responsable'),
      phone: null,
      group: null,
    },
  ];
  teams.forEach((team, i) =>
    accounts.push({
      role: 'team_lead',
      name: LEADS[i].join(' '),
      email: mail(`chef${i + 1}`),
      phone: phone(),
      group: team,
    }),
  );
  const fil = content.agentName.trim() || 'Koffi';
  for (let i = 0; i < agents; i++) {
    const first = i === 0 ? fil : FIRST[(i - 1) % FIRST.length];
    accounts.push({
      role: 'agent',
      name: `${first} ${i === 0 ? 'Brou' : LAST[(i - 1) % LAST.length]}`,
      email: mail(`agent${i + 1}`),
      phone: phone(),
      group: teams[i % teams.length],
    });
  }
  return accounts;
}

/** Crée la structure (dans la transaction de `m`, Row Level Security contournée). */
export async function createDemoStructure(
  m: EntityManager,
  redis: Redis,
  input: DemoInput,
) {
  const { tenantId, content, passwordHash } = input;
  const M = content.modules;
  const q = (sql: string, params: unknown[] = []) =>
    m.query<Row[]>(sql, params);
  const seed = parseInt(tenantId.replace(/-/g, '').slice(0, 8), 16);
  const { rand, chance, pick } = random(seed);
  const now = Date.now();
  const today = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const iso = (t: number) => new Date(t).toISOString();

  // --- Réglages, apparence, abonnement d'essai ----------------------------------------
  await q(
    `INSERT INTO tenant_settings (tenant_id, use_groups, alert_start_time, alert_late_minutes,
                                  daily_report_time, workday_minutes, last_reset_date)
     VALUES ($1, true, '08:00', 15, '19:00', 480, (now() AT TIME ZONE 'Africa/Abidjan')::date)`,
    [tenantId],
  );
  await q(
    `INSERT INTO tenant_branding (tenant_id, display_name, primary_color, welcome_message, support_phone)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      tenantId,
      content.clientName.slice(0, 60),
      content.color.toUpperCase(),
      `Bonne journée sur le terrain avec ${content.clientName} !`,
      content.supportPhone || null,
    ],
  );
  await q(
    `INSERT INTO subscriptions (tenant_id, plan_code, billing_cycle, status, trial_ends_at)
     SELECT $1, ps.trial_plan_code, 'monthly', 'trialing', now() + interval '30 days'
     FROM platform_settings ps LIMIT 1`,
    [tenantId],
  );

  // --- Zones, équipes, comptes ---------------------------------------------------------
  const zones: { id: string; name: string; box: Box }[] = [];
  for (const z of demoZones(content.areas)) {
    const [{ id }] = await q(
      `INSERT INTO zones (tenant_id, name, area, capacity, sensitive, created_at)
       VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), NULL, false, $4) RETURNING id`,
      [tenantId, z.name, polygon(z.box), iso(today - 30 * DAY)],
    );
    zones.push({ id, ...z });
  }

  const accounts = demoAccounts(content, input.code, input.phoneBlock);
  const user = async (a: DemoAccount, groupId: string | null) => {
    const [first, ...last] = a.name.split(' ');
    const [{ id }] = await q(
      `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, phone, group_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        tenantId,
        a.email,
        passwordHash,
        first,
        last.join(' ') || content.clientName,
        a.role,
        a.phone,
        groupId,
        iso(today - 30 * DAY),
      ],
    );
    return id;
  };
  const adminId = await user(accounts[0], null);
  const groups = new Map<
    string,
    { id: string; leaderId: string; zones: string[] }
  >();
  const leads = accounts.filter((a) => a.role === 'team_lead');
  for (const [i, lead] of leads.entries()) {
    const leaderId = await user(lead, null);
    const [{ id }] = await q(
      `INSERT INTO groups (tenant_id, name, leader_id) VALUES ($1, $2, $3) RETURNING id`,
      [tenantId, lead.group, leaderId],
    );
    // Zones réparties entre les équipes (chacune en a au moins une).
    const own = zones.filter((_, k) => k % leads.length === i);
    const mine = own.length ? own : [zones[i % zones.length]];
    for (const z of mine)
      await q(
        `INSERT INTO group_zones (group_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
        [id, z.id, tenantId],
      );
    groups.set(lead.group!, { id, leaderId, zones: mine.map((z) => z.id) });
  }
  const agents: { id: string; name: string; group: string; zoneId: string }[] =
    [];
  for (const [i, a] of accounts.filter((x) => x.role === 'agent').entries()) {
    const g = groups.get(a.group!)!;
    agents.push({
      id: await user(a, g.id),
      name: a.name,
      group: a.group!,
      zoneId: g.zones[i % g.zones.length],
    });
  }

  // --- Missions (formulaire de visite) ----------------------------------------------------
  const [{ id: typeId }] = await q(
    `INSERT INTO mission_types (tenant_id, name, description, fields) VALUES ($1, 'Visite client', $2, $3) RETURNING id`,
    [
      tenantId,
      'Visite d’un point de vente : présence, intérêt, commande.',
      JSON.stringify(VISIT_FORM),
    ],
  );
  const missionOf = new Map<string, string>();
  if (M.missions) {
    for (const [name, g] of groups) {
      const [{ id }] = await q(
        `INSERT INTO missions (tenant_id, type_id, title, description, assignee_group_id, progress_method,
                               target_value, due_date, created_at, created_by_id)
         VALUES ($1, $2, $3, $4, $5, 'count', $6, $7, $8, $9) RETURNING id`,
        [
          tenantId,
          typeId,
          `${name} – visites de la semaine`,
          'Une visite = un formulaire, même si le client n’est pas intéressé.',
          g.id,
          60,
          iso(today + 3 * DAY + 18 * 3600 * 1000),
          iso(today - DAYS_BACK * DAY + 7 * 3600 * 1000),
          g.leaderId,
        ],
      );
      for (const zoneId of g.zones)
        await q(
          `INSERT INTO mission_zones (mission_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
          [id, zoneId, tenantId],
        );
      missionOf.set(name, id);
    }
  }

  // --- Points de vente et produits ----------------------------------------------------
  const outletsByZone = new Map<
    string,
    { id: string; name: string; lat: number; lng: number }[]
  >();
  if (M.outlets || M.orders) {
    const products = content.products.length
      ? content.products
      : ['Produit A', 'Produit B', 'Produit C'];
    for (const name of products)
      await q(
        `INSERT INTO products (tenant_id, name, own) VALUES ($1, $2, true)`,
        [tenantId, name],
      );
    let k = 0;
    for (const z of zones) {
      const [w, s, e, n] = z.box;
      const list: { id: string; name: string; lat: number; lng: number }[] = [];
      for (let i = 0; i < 5; i++) {
        const name = `${COMMERCES[k++ % COMMERCES.length]}${k > COMMERCES.length ? ` ${Math.ceil(k / COMMERCES.length)}` : ''}`;
        const lat = Number(
          rand(s + (n - s) * 0.15, n - (n - s) * 0.15).toFixed(6),
        );
        const lng = Number(
          rand(w + (e - w) * 0.15, e - (e - w) * 0.15).toFixed(6),
        );
        const [{ id }] = await q(
          `INSERT INTO outlets (tenant_id, name, category, manager_name, phone, landmark, location, accuracy, status, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, ST_SetSRID(ST_MakePoint($7, $8), 4326), 8, 'active', $9, $10) RETURNING id`,
          [
            tenantId,
            name,
            pick(CATEGORIES),
            `${pick(FIRST)} ${pick(LAST)}`,
            null,
            `Près du carrefour ${z.name}`,
            lng,
            lat,
            adminId,
            iso(today - 20 * DAY),
          ],
        );
        list.push({ id, name, lat, lng });
      }
      outletsByZone.set(z.id, list);
    }
  }

  // --- Rémunération ---------------------------------------------------------------------
  if (M.pay) {
    await q(
      `INSERT INTO pay_settings (tenant_id, period) VALUES ($1, 'monthly')`,
      [tenantId],
    );
    await q(
      `INSERT INTO pay_grids (tenant_id, name, components, targets) VALUES ($1, 'Agents terrain', $2, '{"roles": ["agent"]}')`,
      [
        tenantId,
        JSON.stringify({
          fixed: 60000,
          perDay: { amount: 2000, minHours: 6, requireInZone: true },
          perForm: { amount: 150 },
          cap: 200000,
        }),
      ],
    );
  }

  // --- Activité : 6 jours passés et la journée en cours --------------------------------
  // Aujourd'hui : la plupart en journée, un en pause, un hors zone, un sans signal, un pas commencé.
  const scenarios = [
    'active',
    'active',
    'paused',
    'active',
    'outside',
    'active',
    'none',
    'active',
    'lost',
    'active',
    'active',
    'active',
  ];
  const boxOf = new Map(zones.map((z) => [z.id, z.box]));
  await redis.del(`live:${tenantId}`);
  let days = 0;
  let positions = 0;
  let submissions = 0;

  for (let back = DAYS_BACK; back >= 0; back--) {
    const base = today - back * DAY;
    const isToday = back === 0;
    if (new Date(base).getUTCDay() === 0 && !isToday) continue; // dimanche
    for (const [i, agent] of agents.entries()) {
      const scenario = isToday ? scenarios[i % scenarios.length] : 'past';
      if (!isToday && !chance(0.9)) continue;
      if (scenario === 'none') continue;
      const box = boxOf.get(agent.zoneId)!;
      const workDate = iso(base).slice(0, 10);
      let start = base + (7 * 60 + 40 + rand(0, 45)) * MINUTE;
      if (isToday && now < start + 90 * MINUTE)
        start = now - rand(100, 160) * MINUTE;
      const lunch = base + (12 * 60 + 15 + rand(0, 40)) * MINUTE;
      const pauses: [number, number][] = [
        [lunch, lunch + rand(30, 55) * MINUTE],
      ];
      let end = base + (16 * 60 + 30 + rand(0, 80)) * MINUTE;
      let trackUntil = end;
      let status = 'ended';
      let current: number | null = null;
      if (isToday) {
        status = scenario === 'paused' ? 'paused' : 'active';
        end = now;
        trackUntil =
          scenario === 'lost'
            ? now - rand(25, 40) * MINUTE
            : now - rand(20, 70) * 1000;
        for (let k = pauses.length - 1; k >= 0; k--) {
          if (pauses[k][0] > now - 10 * MINUTE || pauses[k][0] < start)
            pauses.splice(k, 1);
          else if (pauses[k][1] > now) pauses[k][1] = now - 2 * MINUTE;
        }
        if (scenario === 'paused') {
          current = now - rand(8, 18) * MINUTE;
          trackUntil = current;
        }
      }

      await q(
        `INSERT INTO zone_requests (tenant_id, agent_id, zone_id, status, requires_approval, work_date, decided_at, decision_reason, released_at, release_reason, created_at)
         VALUES ($1, $2, $3, $4, false, $5, $6, 'auto', $7, $8, $6)`,
        [
          tenantId,
          agent.id,
          agent.zoneId,
          isToday ? 'approved' : 'released',
          workDate,
          iso(start - 15 * MINUTE),
          isToday ? null : iso(end),
          isToday ? null : 'day_ended',
        ],
      );
      const [{ id: dayId }] = await q(
        `INSERT INTO work_days (tenant_id, agent_id, zone_id, status, work_date, started_at, ended_at, end_reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $6) RETURNING id`,
        [
          tenantId,
          agent.id,
          agent.zoneId,
          status,
          workDate,
          iso(start),
          isToday ? null : iso(end),
          isToday ? null : 'manual',
        ],
      );
      for (const [a, b] of pauses)
        await q(
          `INSERT INTO day_pauses (tenant_id, day_id, started_at, ended_at) VALUES ($1, $2, $3, $4)`,
          [tenantId, dayId, iso(a), iso(b)],
        );
      if (current)
        await q(
          `INSERT INTO day_pauses (tenant_id, day_id, started_at) VALUES ($1, $2, $3)`,
          [tenantId, dayId, iso(current)],
        );

      // Itinéraire : marche aléatoire dans la zone, hors pauses.
      const [w, s, e, n] = box;
      let lat = rand(s + (n - s) * 0.2, n - (n - s) * 0.2);
      let lng = rand(w + (e - w) * 0.2, e - (e - w) * 0.2);
      let heading = rand(0, Math.PI * 2);
      let battery = rand(0.8, 1);
      const points: {
        lat: number;
        lng: number;
        accuracy: number;
        speed: number;
        battery: number;
        at: string;
      }[] = [];
      for (let t = start; t <= trackUntil; t += rand(90, 160) * 1000) {
        if (pauses.some(([a, b]) => t >= a && t <= b)) continue;
        heading += (rand(0, 1) - 0.5) * 0.9;
        const step = rand(0.00008, 0.0003);
        lat += Math.cos(heading) * step;
        lng += Math.sin(heading) * step;
        if (
          lat < s + 0.0006 ||
          lat > n - 0.0006 ||
          lng < w + 0.0006 ||
          lng > e - 0.0006
        )
          heading =
            Math.atan2((w + e) / 2 - lng, (s + n) / 2 - lat) +
            (rand(0, 1) - 0.5) * 0.6;
        battery = Math.max(0.1, battery - rand(0.0008, 0.002));
        points.push({
          lat: Number(lat.toFixed(6)),
          lng: Number(lng.toFixed(6)),
          accuracy: Math.round(rand(4, 20)),
          speed: Number(rand(0, 1.5).toFixed(2)),
          battery: Number(battery.toFixed(2)),
          at: iso(t),
        });
      }
      if (scenario === 'outside' && points.length) {
        // Dernières positions franchement hors de la zone.
        const last = points[points.length - 1];
        for (let k = 1; k <= 8; k++)
          points.push({
            ...last,
            lat: Number((n + 0.003 + k * 0.0004).toFixed(6)),
            at: iso(Date.parse(last.at) + k * 20_000),
          });
        const kept = points.filter((p) => Date.parse(p.at) < now);
        points.splice(0, points.length, ...kept);
      }
      for (let k = 0; k < points.length; k += 500) {
        await q(
          `INSERT INTO positions (tenant_id, agent_id, day_id, lat, lng, location, accuracy, speed, battery_level, is_mocked, outside_zone, recorded_at, received_at)
           SELECT $1, $2, $3, p.lat, p.lng, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), p.accuracy, p.speed, p.battery, false,
                  NOT ST_Contains(z.area, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)), p.at, p.at
           FROM jsonb_to_recordset($4::jsonb) AS p(lat float8, lng float8, accuracy float4, speed float4, battery float4, at timestamptz)
           JOIN zones z ON z.id = $5
           ON CONFLICT DO NOTHING`,
          [
            tenantId,
            agent.id,
            dayId,
            JSON.stringify(points.slice(k, k + 500)),
            agent.zoneId,
          ],
        );
      }
      positions += points.length;
      days++;

      // Visites : formulaires le long de l'itinéraire, chez les points de vente de la zone.
      const mission = missionOf.get(agent.group);
      const outlets = outletsByZone.get(agent.zoneId) ?? [];
      const forms =
        mission && points.length > 10
          ? Math.floor(isToday ? rand(1, 4) : rand(3, 7))
          : 0;
      for (let k = 0; k < forms; k++) {
        const p = points[Math.floor(rand(5, points.length - 1))];
        const outlet = outlets.length ? pick(outlets) : null;
        const interested = chance(0.6);
        await q(
          `INSERT INTO mission_submissions (tenant_id, mission_id, type_id, agent_id, day_id, client_id, outlet_id, data, lat, lng, submitted_at, received_at, status)
           VALUES ($1, $2, $3, $4, $5, gen_random_uuid(), $6, $7, $8, $9, $10, $10, 'accepted')`,
          [
            tenantId,
            mission,
            typeId,
            agent.id,
            dayId,
            outlet?.id ?? null,
            JSON.stringify({
              commerce: outlet?.name ?? pick(COMMERCES),
              categorie: pick(CATEGORIES),
              interesse: interested,
              ...(interested && chance(0.5)
                ? { montant: Math.round(rand(10, 90)) * 1000 }
                : {}),
            }),
            outlet?.lat ?? p.lat,
            outlet?.lng ?? p.lng,
            p.at,
          ],
        );
        submissions++;
      }

      // Carte en direct : dernière position des journées en cours.
      if (isToday && points.length) {
        const last = points[points.length - 1];
        await redis.hset(
          `live:${tenantId}`,
          agent.id,
          JSON.stringify({
            agentId: agent.id,
            dayId,
            zoneId: agent.zoneId,
            status,
            lat: last.lat,
            lng: last.lng,
            accuracy: last.accuracy,
            batteryLevel: last.battery,
            isMocked: false,
            outsideZone:
              last.lat < s || last.lat > n || last.lng < w || last.lng > e,
            recordedAt: last.at,
            receivedAt: last.at,
          }),
        );
      }
    }
  }

  // Avancement des missions.
  await q(
    `UPDATE missions m SET status = CASE WHEN p.value >= m.target_value THEN 'achieved'
                                         WHEN p.value > 0 THEN 'in_progress' ELSE 'todo' END
     FROM (SELECT m2.id, count(s.id) AS value FROM missions m2
           LEFT JOIN mission_submissions s ON s.mission_id = m2.id AND s.status = 'accepted'
           WHERE m2.tenant_id = $1 GROUP BY m2.id) p
     WHERE p.id = m.id`,
    [tenantId],
  );

  return { accounts, zones: zones.length, days, positions, submissions };
}
