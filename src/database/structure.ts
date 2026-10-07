/**
 * Crée une structure complète et prête à l'emploi (prod comprise) : réglages, zones d'Abidjan,
 * groupes et chefs d'équipe, agents, types de missions et formulaires, missions par zone,
 * grilles de rémunération. Aucune activité inventée : la structure démarre « propre ».
 *
 * Local :  npm run seed:structure -- --admin vous@exemple.ci [options]
 * Prod :   docker compose -f docker-compose.prod.yml exec api \
 *            node dist/database/structure.js --admin vous@exemple.ci [options]
 *
 * Options :
 *   --admin <email>       administrateur de la structure (obligatoire)
 *   --name <nom>          nom de la structure (défaut : « Distribution Ivoire »)
 *   --password <mdp>      mot de passe de tous les comptes (défaut : généré et affiché)
 *   --phones <préfixe>    début des numéros des agents et chefs (défaut : 07990)
 *   --support <tél>       numéro affiché aux agents dans l'app
 *   --replace             supprime puis recrée la structure de cet administrateur
 *
 * Les e-mails des chefs et des agents dérivent de celui de l'administrateur
 * (vous+chef-nord@exemple.ci) : uniques, et reçus dans sa boîte.
 */
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import 'dotenv/config';
import dataSource from './data-source';

type Row = Record<string, string>;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

/** Rectangle GeoJSON [ouest, sud, est, nord]. */
const box = (w: number, s: number, e: number, n: number) =>
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

/** Communes d'Abidjan (périmètres simplifiés, ajustables ensuite sur la carte). */
const ZONES = [
  {
    key: 'plateau',
    name: 'Plateau',
    area: box(-4.03, 5.31, -4.01, 5.33),
    capacity: 4,
  },
  {
    key: 'treichville',
    name: 'Treichville',
    area: box(-4.012, 5.29, -3.992, 5.305),
    capacity: 3,
  },
  {
    key: 'adjame',
    name: 'Adjamé',
    area: box(-4.04, 5.345, -4.015, 5.37),
    capacity: 4,
  },
  {
    key: 'abobo',
    name: 'Abobo',
    area: box(-4.04, 5.4, -4.0, 5.44),
    capacity: 5,
  },
  {
    key: 'angre',
    name: 'Cocody Angré',
    area: box(-3.995, 5.38, -3.96, 5.405),
    capacity: 3,
  },
  {
    key: 'riviera',
    name: 'Cocody Riviera',
    area: box(-3.985, 5.34, -3.95, 5.37),
    capacity: null,
  },
  {
    key: 'marcory',
    name: 'Marcory',
    area: box(-3.988, 5.285, -3.962, 5.304),
    capacity: 3,
  },
  {
    key: 'koumassi',
    name: 'Koumassi',
    area: box(-3.958, 5.285, -3.93, 5.305),
    capacity: 3,
  },
  {
    key: 'yopougon',
    name: 'Yopougon',
    area: box(-4.1, 5.32, -4.06, 5.36),
    capacity: 5,
  },
] as const;
type ZoneKey = (typeof ZONES)[number]['key'];

/** Équipes : chef, zones et agents. Cocody Riviera reste libre (ouverte à tous). */
const TEAMS: {
  key: string;
  name: string;
  lead: [string, string];
  zones: ZoneKey[];
  agents: [string, string][];
}[] = [
  {
    key: 'nord',
    name: 'Équipe Nord',
    lead: ['Yao', 'Kouassi'],
    zones: ['adjame', 'abobo', 'angre'],
    agents: [
      ['Koffi', 'Brou'],
      ['Aminata', 'Diallo'],
      ['Serge', 'Gnagne'],
      ['Mariam', 'Koné'],
    ],
  },
  {
    key: 'centre',
    name: 'Équipe Centre',
    lead: ['Clarisse', 'Ahoua'],
    zones: ['plateau', 'treichville'],
    agents: [
      ['Jean-Marc', 'Aka'],
      ['Rokia', 'Touré'],
      ['Didier', 'Kipré'],
      ['Awa', 'Bamba'],
    ],
  },
  {
    key: 'sud',
    name: 'Équipe Sud',
    lead: ['Ibrahim', 'Coulibaly'],
    zones: ['marcory', 'koumassi', 'yopougon'],
    agents: [
      ['Fatou', 'Ouattara'],
      ['Hervé', 'Yao'],
      ['Nadia', 'Yapi'],
      ['Moussa', 'Sanogo'],
    ],
  },
];

const PROSPECTION = [
  { key: 'commerce', label: 'Nom du commerce', type: 'text', required: true },
  { key: 'gerant', label: 'Nom du gérant', type: 'text', required: false },
  {
    key: 'categorie',
    label: 'Catégorie',
    type: 'select',
    required: true,
    options: [
      'Boutique',
      'Supermarché',
      'Pharmacie',
      'Kiosque',
      'Station-service',
    ],
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
  { key: 'relance', label: 'Date de relance', type: 'date', required: false },
];
const PRIX = [
  { key: 'commerce', label: 'Point de vente', type: 'text', required: true },
  {
    key: 'produit',
    label: 'Produit',
    type: 'select',
    required: true,
    options: ['Riz 25 kg', 'Huile 5 L', 'Sucre 1 kg', 'Lait en poudre 400 g'],
  },
  {
    key: 'prix',
    label: 'Prix constaté (FCFA)',
    type: 'number',
    required: true,
  },
  {
    key: 'rupture',
    label: 'Produit en rupture',
    type: 'boolean',
    required: true,
  },
];
const AUDIT = [
  { key: 'commerce', label: 'Point de vente', type: 'text', required: true },
  {
    key: 'proprete',
    label: 'Propreté du rayon',
    type: 'select',
    required: true,
    options: ['Très bien', 'Correct', 'À améliorer'],
  },
  { key: 'plv', label: 'PLV en place', type: 'boolean', required: true },
  {
    key: 'facing',
    label: 'Nombre de facings',
    type: 'number',
    required: false,
  },
  { key: 'remarque', label: 'Remarques', type: 'text', required: false },
];

const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

async function main() {
  const admin = arg('admin')?.trim().toLowerCase();
  if (!admin || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(admin)) {
    throw new Error('Indiquez l’administrateur : --admin vous@exemple.ci');
  }
  const name = arg('name') ?? 'Distribution Ivoire';
  const password =
    arg('password') ?? `Suivi-${randomBytes(4).toString('hex')}!`;
  if (password.length < 8)
    throw new Error('Mot de passe : 8 caractères au moins');
  const prefix = (arg('phones') ?? '07990').replace(/\D/g, '');
  if (prefix.length < 3 || prefix.length > 6)
    throw new Error('--phones : de 3 à 6 chiffres (ex. 07990)');
  const support = arg('support');
  /** +2250799000001 → 07 99 00 00 01 (ce que l'agent tape dans l'app). */
  const local10 = (tel: string) =>
    tel.replace('+225', '').replace(/(\d{2})(?=\d)/g, '$1 ');
  const [local, domain] = admin.split('@');
  const email = (tag: string) => `${local}+${tag}@${domain}`;
  /** Numéro complet (10 chiffres) : préfixe + rang. */
  const phone = (n: number) =>
    `+225${prefix}${String(n).padStart(10 - prefix.length, '0')}`;

  await dataSource.initialize();
  const q = (sql: string, params: unknown[] = []) =>
    dataSource.query<Row[]>(sql, params);

  // Comptes prévus : aucun ne doit déjà exister (sauf ceux de la structure remplacée).
  const accounts: { email: string; phone: string | null }[] = [
    { email: admin, phone: null },
  ];
  let n = 1;
  for (const team of TEAMS) {
    accounts.push({ email: email(`chef-${team.key}`), phone: phone(n++) });
    for (const [first, last] of team.agents)
      accounts.push({
        email: email(slug(`${first}-${last}`)),
        phone: phone(n++),
      });
  }

  const [existing] = await q(
    `SELECT u.tenant_id, t.name FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = $1`,
    [admin],
  );
  if (existing && !process.argv.includes('--replace')) {
    throw new Error(
      `${admin} administre déjà « ${existing.name} ». Relancez avec --replace pour la recréer (ses données seront supprimées).`,
    );
  }
  const taken = await q(
    `SELECT email, phone FROM users
     WHERE (lower(email) = ANY($1) OR phone = ANY($2)) AND ($3::uuid IS NULL OR tenant_id <> $3)`,
    [
      accounts.map((a) => a.email),
      accounts.map((a) => a.phone).filter(Boolean),
      existing?.tenant_id ?? null,
    ],
  );
  if (taken.length) {
    throw new Error(
      `Comptes déjà utilisés ailleurs : ${taken.map((t) => t.phone ?? t.email).join(', ')}. ` +
        'Changez --phones ou l’adresse --admin.',
    );
  }

  const hash = await bcrypt.hash(password, 10);
  const lines: string[][] = [];
  await dataSource.transaction(async (m) => {
    const t = (sql: string, params: unknown[] = []) =>
      m.query<Row[]>(sql, params);
    await t(`SELECT set_config('app.bypass_rls', 'on', true)`);
    if (existing)
      await t(`DELETE FROM tenants WHERE id = $1`, [existing.tenant_id]);

    const [{ id: tenantId }] = await t(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
      [name],
    );
    // Réglages : groupes, journée de 8 h, retard après 8 h 15, bilan à 19 h,
    // formulaires seulement pendant la journée.
    await t(
      `INSERT INTO tenant_settings (tenant_id, use_groups, alert_start_time, alert_late_minutes,
                                    daily_report_time, workday_minutes, submission_requires_day,
                                    last_reset_date)
       VALUES ($1, true, '08:00', 15, '19:00', 480, true, (now() AT TIME ZONE 'Africa/Abidjan')::date)`,
      [tenantId],
    );
    await t(
      `INSERT INTO tenant_branding (tenant_id, primary_color, welcome_message, support_phone)
       VALUES ($1, '#0F766E', $2, $3)`,
      [
        tenantId,
        'Bonne journée sur le terrain ! Choisissez votre zone, démarrez votre journée en arrivant, puis remplissez un formulaire à chaque visite.',
        support ?? null,
      ],
    );
    // Abonnement : l'essai de la plateforme (l'éditeur le prolonge ou l'active depuis sa console).
    await t(
      `INSERT INTO subscriptions (tenant_id, plan_code, billing_cycle, status, trial_ends_at)
       SELECT $1, ps.trial_plan_code, 'monthly', 'trialing', now() + make_interval(days => ps.trial_days)
       FROM platform_settings ps LIMIT 1`,
      [tenantId],
    );

    const user = async (
      mail: string,
      first: string,
      last: string,
      role: string,
      tel: string | null,
      groupId: string | null = null,
    ) => {
      const [{ id }] = await t(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, phone, group_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [tenantId, mail, hash, first, last, role, tel, groupId],
      );
      return id;
    };
    await user(admin, 'Administrateur', name, 'admin', null);
    lines.push(['Administrateur', `Administrateur ${name}`, admin, '—']);

    const zoneIds = {} as Record<ZoneKey, string>;
    for (const z of ZONES) {
      const [{ id }] = await t(
        `INSERT INTO zones (tenant_id, name, area, capacity, sensitive)
         VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, false) RETURNING id`,
        [tenantId, z.name, z.area, z.capacity],
      );
      zoneIds[z.key] = id;
    }

    let k = 1;
    const teams: Record<string, { id: string; agents: string[] }> = {};
    for (const team of TEAMS) {
      const leadId = await user(
        email(`chef-${team.key}`),
        team.lead[0],
        team.lead[1],
        'team_lead',
        phone(k),
      );
      lines.push([
        `Chef · ${team.name}`,
        team.lead.join(' '),
        email(`chef-${team.key}`),
        local10(phone(k++)),
      ]);
      const [{ id: groupId }] = await t(
        `INSERT INTO groups (tenant_id, name, leader_id) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, team.name, leadId],
      );
      for (const z of team.zones)
        await t(
          `INSERT INTO group_zones (group_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
          [groupId, zoneIds[z], tenantId],
        );
      const agents: string[] = [];
      for (const [first, last] of team.agents) {
        agents.push(
          await user(
            email(slug(`${first}-${last}`)),
            first,
            last,
            'agent',
            phone(k),
            groupId,
          ),
        );
        lines.push([
          `Agent · ${team.name}`,
          `${first} ${last}`,
          '—',
          local10(phone(k++)),
        ]);
      }
      teams[team.key] = { id: groupId, agents };
    }
    // Temps partiel : un agent de l'équipe Centre travaille 4 h par jour.
    await t(`UPDATE users SET workday_minutes = 240 WHERE id = $1`, [
      teams.centre.agents[3],
    ]);

    const type = async (
      typeName: string,
      description: string,
      fields: object,
      pay: object | null = null,
    ) => {
      const [{ id }] = await t(
        `INSERT INTO mission_types (tenant_id, name, description, fields, pay) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          tenantId,
          typeName,
          description,
          JSON.stringify(fields),
          pay && JSON.stringify(pay),
        ],
      );
      return id;
    };
    const prospection = await type(
      'Prospection commerciale',
      'Visite d’un commerce pour présenter l’offre et prendre commande.',
      PROSPECTION,
    );
    const prix = await type(
      'Relevé de prix',
      'Prix constaté et disponibilité d’un produit en rayon.',
      PRIX,
    );
    const audit = await type(
      'Audit point de vente',
      'Contrôle de la présentation en magasin.',
      AUDIT,
      { perForm: 500 },
    );

    const mission = async (m: {
      type: string;
      title: string;
      description: string;
      zones: ZoneKey[];
      group?: string;
      agent?: string;
      method?: 'count' | 'field_sum' | 'manual';
      target: number;
      sumKey?: string;
      days: number;
      pay?: object;
    }) => {
      const [{ id }] = await t(
        `INSERT INTO missions (tenant_id, type_id, title, description, assignee_group_id, assignee_agent_id,
                               progress_method, target_value, sum_field_key, due_date, pay)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                 ((now() AT TIME ZONE 'Africa/Abidjan')::date + $10::int + time '23:59') AT TIME ZONE 'Africa/Abidjan',
                 $11)
         RETURNING id`,
        [
          tenantId,
          m.type,
          m.title,
          m.description,
          m.group ?? null,
          m.agent ?? null,
          m.method ?? 'count',
          m.target,
          m.sumKey ?? null,
          m.days,
          m.pay ? JSON.stringify(m.pay) : null,
        ],
      );
      for (const z of m.zones)
        await t(
          `INSERT INTO mission_zones (mission_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
          [id, zoneIds[z], tenantId],
        );
    };
    await mission({
      type: prospection,
      title: 'Prospection Nord – 200 visites',
      description:
        'Présentez la nouvelle gamme à chaque commerce. Une visite = un formulaire, même si le client n’est pas intéressé.',
      zones: ['adjame', 'abobo', 'angre'],
      group: teams.nord.id,
      target: 200,
      days: 21,
    });
    await mission({
      type: prospection,
      title: 'Commandes Centre – 3 000 000 FCFA',
      description:
        'Objectif de commandes cumulées sur le Plateau et Treichville. Renseignez le montant de chaque commande.',
      zones: ['plateau', 'treichville'],
      group: teams.centre.id,
      method: 'field_sum',
      sumKey: 'montant',
      target: 3_000_000,
      days: 30,
      pay: {
        commissionPercent: 2,
        objectiveBonus: [{ thresholdPercent: 100, amount: 25000 }],
      },
    });
    await mission({
      type: prix,
      title: 'Relevé de prix Sud – 120 relevés',
      description:
        'Relevez les 4 produits suivis dans chaque point de vente visité.',
      zones: ['marcory', 'koumassi', 'yopougon'],
      group: teams.sud.id,
      target: 120,
      days: 14,
    });
    await mission({
      type: prospection,
      title: 'Cocody Riviera – ouverture de zone',
      description:
        'Mission ouverte à tous : premiers contacts dans une zone sans équipe attitrée.',
      zones: ['riviera'],
      target: 60,
      days: 21,
    });
    await mission({
      type: audit,
      title: 'Audit des supermarchés du Plateau',
      description:
        'Contrôlez la présentation des 10 supermarchés partenaires ; votre chef valide le résultat.',
      zones: ['plateau'],
      agent: teams.centre.agents[0],
      method: 'manual',
      target: 1,
      days: 10,
    });

    // Rémunération : paie mensuelle ; une grille pour les agents, une pour les chefs.
    await t(
      `INSERT INTO pay_settings (tenant_id, period) VALUES ($1, 'monthly')`,
      [tenantId],
    );
    await t(
      `INSERT INTO pay_grids (tenant_id, name, components, targets) VALUES
         ($1, 'Agents terrain', $2, '{"roles": ["agent"]}'),
         ($1, 'Chefs d''équipe', $3, '{"roles": ["team_lead"]}')`,
      [
        tenantId,
        JSON.stringify({
          fixed: 60000,
          perDay: { amount: 2000, minHours: 6, requireInZone: true },
          perForm: { amount: 150 },
          objectiveBonus: [
            { thresholdPercent: 100, amount: 10000 },
            { thresholdPercent: 120, amount: 20000 },
          ],
          deductions: {
            perAutoClosedDay: 1000,
            perRejectedForm: 200,
            perMockedDay: 2500,
          },
          cap: 200000,
        }),
        JSON.stringify({
          fixed: 120000,
          teamBonus: { perTeamDay: 300, perTeamForm: 25 },
          objectiveBonus: [{ thresholdPercent: 100, amount: 20000 }],
        }),
      ],
    );
  });

  const width = [0, 0, 0, 0];
  for (const l of lines)
    l.forEach((c, i) => (width[i] = Math.max(width[i], c.length)));
  console.log(`\nStructure « ${name} » créée.\n`);
  console.log(`Mot de passe de tous les comptes : ${password}`);
  console.log('(chacun le change ensuite dans son profil)\n');
  for (const l of [
    ['Rôle', 'Nom', 'E-mail (web)', 'Téléphone (app)'],
    ...lines,
  ])
    console.log(l.map((c, i) => c.padEnd(width[i])).join('   '));
  console.log(
    '\nWeb : connexion par e-mail. App mobile : connexion par numéro de téléphone.\n' +
      '9 zones, 3 groupes et leurs chefs, 12 agents, 3 types de missions, 5 missions, 2 grilles de paie.\n' +
      'Abonnement : essai de la plateforme (à prolonger ou activer depuis la console éditeur).',
  );
  await dataSource.destroy();
}

main().catch(async (error: Error) => {
  console.error(`\nÉchec : ${error.message}`);
  if (dataSource.isInitialized) await dataSource.destroy();
  process.exit(1);
});
