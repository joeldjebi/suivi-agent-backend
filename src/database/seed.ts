/**
 * Données de démonstration : une structure à Abidjan, prête à tester dans Swagger.
 * Usage : npm run seed            (ne fait rien si la démo existe déjà)
 *         npm run seed -- --reset (supprime puis recrée la démo)
 *         npm run seed:demo       (démo + 14 jours d'activité et la journée en cours)
 *         npm run seed -- --platform (espace éditeur seul : super administrateur et portefeuille)
 */
import * as bcrypt from 'bcrypt';
import 'dotenv/config';
import { generateActivity } from './activity';
import { DEMO_PLATFORM_ADMIN, seedPlatform } from './platform-demo';
import dataSource from './data-source';
import { MISSION_ZONES_BACKFILL } from './mission-zones';

const PASSWORD = 'Password123!';
const DEMO_ADMIN = 'admin@demo.ci';

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

const ZONES = [
  {
    name: 'Plateau',
    area: box(-4.03, 5.31, -4.01, 5.33),
    capacity: 3,
    sensitive: false,
  },
  {
    name: 'Cocody',
    area: box(-4.0, 5.34, -3.96, 5.37),
    capacity: 4,
    sensitive: true,
  },
  {
    name: 'Yopougon',
    area: box(-4.1, 5.32, -4.06, 5.36),
    capacity: 2,
    sensitive: false,
  },
  {
    name: 'Marcory',
    area: box(-3.99, 5.29, -3.96, 5.31),
    capacity: null,
    sensitive: false,
  },
];

type Row = Record<string, string>;

async function main() {
  await dataSource.initialize();
  const q = (sql: string, params: unknown[] = []) =>
    dataSource.query<Row[]>(sql, params);

  const [existing] = await q(`SELECT tenant_id FROM users WHERE email = $1`, [
    DEMO_ADMIN,
  ]);
  if (existing && !process.argv.includes('--reset')) {
    // Espace de l'éditeur seul, sans toucher à la démo existante.
    if (process.argv.includes('--platform')) {
      await seedPlatform(dataSource, await bcrypt.hash(PASSWORD, 10));
      console.log(
        `Espace éditeur prêt : ${DEMO_PLATFORM_ADMIN} / ${PASSWORD} (portefeuille de démo recréé)`,
      );
      return;
    }
    console.log('La démo existe déjà. Relancez avec --reset pour la recréer.');
    return;
  }
  if (existing)
    await q(`DELETE FROM tenants WHERE id = $1`, [existing.tenant_id]);

  const hash = await bcrypt.hash(PASSWORD, 10);
  let demoTenantId = '';
  await dataSource.transaction(async (m) => {
    const t = (sql: string, params: unknown[] = []) =>
      m.query<Row[]>(sql, params);
    const [{ id: tenantId }] = await t(
      `INSERT INTO tenants (name) VALUES ('Démo Abidjan') RETURNING id`,
    );
    demoTenantId = tenantId;
    // Personnalisation visible dans l'app mobile une fois l'agent connecté.
    await t(
      `INSERT INTO tenant_branding (tenant_id, primary_color, welcome_message, support_phone)
       VALUES ($1, '#0F766E', 'Bonne journée sur le terrain ! Pensez à démarrer votre journée en arrivant dans votre zone.', '+225 07 07 07 07 07')`,
      [tenantId],
    );
    await t(
      `INSERT INTO tenant_settings (tenant_id, use_groups, last_reset_date)
       VALUES ($1, true, (now() AT TIME ZONE 'Africa/Abidjan')::date)`,
      [tenantId],
    );
    // Rémunération : paie mensuelle, une grille pour les agents, une pour les chefs.
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
          fixed: 40000,
          perDay: { amount: 2500, minHours: 6, requireInZone: true },
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
          cap: 150000,
        }),
        JSON.stringify({
          fixed: 90000,
          teamBonus: { perTeamDay: 300, perTeamForm: 25 },
          objectiveBonus: [{ thresholdPercent: 100, amount: 15000 }],
        }),
      ],
    );

    // Cliente depuis trois mois, formule Entreprise (forfait) ; factures des mois passés réglées.
    await t(
      `INSERT INTO subscriptions (tenant_id, plan_code, billing_cycle, status, created_at)
       VALUES ($1, 'enterprise', 'monthly', 'active', now() - interval '3 months')`,
      [tenantId],
    );
    await t(
      `INSERT INTO invoices (tenant_id, number, month, plan_code, billing_cycle, agents, base_price,
                             amount, currency, status, issued_at, due_at, paid_at, payment_reference)
       SELECT $1, 'F-' || to_char(m, 'YYYYMM') || '-' || upper(left($1::text, 8)), m, 'enterprise', 'monthly',
              n, 40000, 40000, 'XOF', 'paid', m + interval '1 month', m + interval '1 month 15 days',
              m + interval '1 month 6 days', 'Orange Money ' || to_char(m, 'MMYY')
       FROM (VALUES (date_trunc('month', now()) - interval '2 months', 14),
                    (date_trunc('month', now()) - interval '1 month', 16)) AS v(m, n)`,
      [tenantId],
    );

    const user = async (
      email: string,
      first: string,
      last: string,
      role: string,
      phone: string | null = null,
    ) => {
      const [{ id }] = await t(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [tenantId, email, hash, first, last, role, phone],
      );
      return id;
    };

    await user(DEMO_ADMIN, 'Awa', 'Koné', 'admin');
    const lead1 = await user(
      'chef1@demo.ci',
      'Yao',
      'Kouassi',
      'team_lead',
      '+2250701010101',
    );
    const lead2 = await user(
      'chef2@demo.ci',
      'Mariam',
      'Traoré',
      'team_lead',
      '+2250701010102',
    );

    const zoneIds: Record<string, string> = {};
    for (const z of ZONES) {
      const [{ id }] = await t(
        `INSERT INTO zones (tenant_id, name, area, capacity, sensitive)
         VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5) RETURNING id`,
        [tenantId, z.name, z.area, z.capacity, z.sensitive],
      );
      zoneIds[z.name] = id;
    }

    const group = async (name: string, leaderId: string, zones: string[]) => {
      const [{ id }] = await t(
        `INSERT INTO groups (tenant_id, name, leader_id) VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, name, leaderId],
      );
      for (const zone of zones) {
        await t(
          `INSERT INTO group_zones (group_id, zone_id, tenant_id) VALUES ($1, $2, $3)`,
          [id, zoneIds[zone], tenantId],
        );
      }
      return id;
    };
    const north = await group('Équipe Nord', lead1, ['Plateau', 'Cocody']);
    const south = await group('Équipe Sud', lead2, ['Yopougon', 'Marcory']);

    const agents = [
      ['agent1@demo.ci', 'Koffi', 'Brou', north],
      ['agent2@demo.ci', 'Aminata', 'Diallo', north],
      ['agent3@demo.ci', 'Serge', 'Gbagbo', north],
      ['agent4@demo.ci', 'Fatou', 'Ouattara', south],
      ['agent5@demo.ci', 'Ibrahim', 'Coulibaly', south],
      ['agent6@demo.ci', 'Nadia', 'Yapi', south],
    ];
    for (const [index, [email, first, last, groupId]] of agents.entries()) {
      const id = await user(
        email,
        first,
        last,
        'agent',
        `+22507020202${String(index + 1).padStart(2, '0')}`,
      );
      await t(`UPDATE users SET group_id = $1 WHERE id = $2`, [groupId, id]);
    }

    const [{ id: typeId }] = await t(
      `INSERT INTO mission_types (tenant_id, name, description, fields) VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        tenantId,
        'Prospection',
        'Visite d’un commerce pour présenter l’offre',
        JSON.stringify([
          {
            key: 'commerce',
            label: 'Nom du commerce',
            type: 'text',
            required: true,
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
          {
            key: 'categorie',
            label: 'Catégorie',
            type: 'select',
            required: false,
            options: ['Boutique', 'Supermarché', 'Pharmacie'],
          },
        ]),
      ],
    );
    await t(
      `INSERT INTO missions (tenant_id, type_id, title, assignee_group_id, progress_method, target_value, due_date)
       VALUES ($1, $2, '50 visites cette semaine', $3, 'count', 50, now() + interval '7 days')`,
      [tenantId, typeId, north],
    );
    for (const sql of MISSION_ZONES_BACKFILL) await t(sql, [tenantId]);
  });

  // Espace de l'éditeur : compte super administrateur et portefeuille de structures clientes.
  await seedPlatform(dataSource, hash);

  if (process.argv.includes('--activity')) {
    const stats = await generateActivity(dataSource, demoTenantId, hash);
    console.log(
      `Activité générée : ${stats.agents} agents, ${stats.days} journées, ${stats.positions} positions, ${stats.submissions} formulaires.
  Chef d'équipe supplémentaire : chef3@demo.ci ou 07 01 01 01 03 (Équipe Centre)
  Agents supplémentaires : 07 02 02 02 07 à 07 02 02 02 16`,
    );
  }

  console.log(`Démo créée. Mot de passe de tous les comptes : ${PASSWORD}
  Administrateur (web)          : ${DEMO_ADMIN}
  Chefs d'équipe (web + mobile) : chef1@demo.ci ou 07 01 01 01 01 (Équipe Nord), chef2@demo.ci ou 07 01 01 01 02 (Équipe Sud)
  Agents (mobile)               : 07 02 02 02 01 à 07 02 02 02 03 (Nord), 07 02 02 02 04 à 07 02 02 02 06 (Sud)
  Super administrateur (éditeur): ${DEMO_PLATFORM_ADMIN} (espace /platform)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => dataSource.destroy());
