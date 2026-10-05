import type { DataSource } from 'typeorm';

/** Compte super administrateur de démonstration (espace de l'éditeur). */
export const DEMO_PLATFORM_ADMIN = 'sa@suivi.ci';

interface DemoTenant {
  name: string;
  admin: string;
  plan: 'base' | 'advanced' | 'enterprise';
  cycle?: 'monthly' | 'annual';
  status: 'trialing' | 'active' | 'past_due' | 'suspended';
  agents: number;
  leads: number;
  /** Ancienneté (mois) */
  age: number;
  customPrice?: number;
  trialDaysLeft?: number;
  /** Factures des mois passés : payées, sauf les n dernières */
  unpaid?: number;
  /** Journées par jour ouvré sur les 20 derniers jours */
  activity: number;
}

/** Portefeuille de clients variés : un tableau de bord parlant pour l'éditeur. */
const PORTFOLIO: DemoTenant[] = [
  {
    name: 'Distribution Bouaké',
    admin: 'direction@distrib-bouake.ci',
    plan: 'advanced',
    status: 'active',
    agents: 22,
    leads: 2,
    age: 7,
    activity: 14,
  },
  {
    name: 'Agro Daloa',
    admin: 'admin@agro-daloa.ci',
    plan: 'enterprise',
    cycle: 'annual',
    status: 'active',
    agents: 64,
    leads: 6,
    age: 11,
    customPrice: 35000,
    activity: 40,
  },
  {
    name: 'Assur Plus San-Pédro',
    admin: 'contact@assurplus-sp.ci',
    plan: 'base',
    status: 'past_due',
    agents: 9,
    leads: 1,
    age: 4,
    unpaid: 1,
    activity: 5,
  },
  {
    name: 'Micro-Finance Korhogo',
    admin: 'admin@mf-korhogo.ci',
    plan: 'advanced',
    status: 'suspended',
    agents: 18,
    leads: 2,
    age: 6,
    unpaid: 2,
    activity: 0,
  },
  {
    name: 'Collecte Yamoussoukro',
    admin: 'gestion@collecte-yakro.ci',
    plan: 'advanced',
    status: 'trialing',
    agents: 6,
    leads: 1,
    age: 0,
    trialDaysLeft: 3,
    activity: 4,
  },
  {
    name: 'Télécom Services Abobo',
    admin: 'admin@ts-abobo.ci',
    plan: 'advanced',
    status: 'trialing',
    agents: 3,
    leads: 0,
    age: 0,
    trialDaysLeft: 11,
    activity: 2,
  },
];

const PRICES = { base: 5000, advanced: 15000, enterprise: 40000 };

export async function seedPlatform(ds: DataSource, hash: string) {
  await ds.transaction(async (m) => {
    const q = <T = Record<string, string>>(
      sql: string,
      params: unknown[] = [],
    ) => m.query<T[]>(sql, params);

    await q(
      `INSERT INTO platform_admins (email, password_hash, first_name, last_name)
       SELECT $1, $2, 'Serge', 'Aka'
       WHERE NOT EXISTS (SELECT 1 FROM platform_admins WHERE lower(email) = $1)`,
      [DEMO_PLATFORM_ADMIN, hash],
    );

    // Recréées à chaque fois : on supprime les structures du portefeuille de démo.
    await q(
      `DELETE FROM tenants WHERE id IN (SELECT tenant_id FROM users WHERE email = ANY($1))`,
      [PORTFOLIO.map((p) => p.admin)],
    );

    for (const [index, demo] of PORTFOLIO.entries()) {
      const created = `now() - interval '${demo.age} months' - interval '${index * 3 + 2} days'`;
      const [{ id }] = await q(
        `INSERT INTO tenants (name, created_at) VALUES ($1, ${created}) RETURNING id`,
        [demo.name],
      );
      await q(
        `INSERT INTO tenant_settings (tenant_id, use_groups) VALUES ($1, $2)`,
        [id, demo.plan !== 'base'],
      );
      await q(`INSERT INTO tenant_branding (tenant_id) VALUES ($1)`, [id]);
      const cycle = demo.cycle ?? 'monthly';
      await q(
        `INSERT INTO subscriptions (tenant_id, plan_code, billing_cycle, status, trial_ends_at,
                                    commitment_ends_at, custom_monthly_price, suspended_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${created})`,
        [
          id,
          demo.plan,
          cycle,
          demo.status,
          demo.trialDaysLeft
            ? new Date(Date.now() + demo.trialDaysLeft * 86400_000)
            : null,
          cycle === 'annual' ? new Date(Date.now() + 120 * 86400_000) : null,
          demo.customPrice ?? null,
          demo.status === 'suspended'
            ? new Date(Date.now() - 4 * 86400_000)
            : null,
        ],
      );

      const [first, ...rest] = demo.admin.split('@')[0].split(/[.-]/);
      await q(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, on_probation)
         VALUES ($1, $2, $3, $4, $5, 'admin', false)`,
        [
          id,
          demo.admin,
          hash,
          first[0].toUpperCase() + first.slice(1),
          rest.join(' ') || 'Admin',
        ],
      );
      const domain = demo.admin.split('@')[1];
      const agents = await q<{ id: string }>(
        `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, on_probation)
         SELECT $1, 'agent' || n || '@' || $2, $3, 'Agent', n::text, 'agent', false
         FROM generate_series(1, $4) n RETURNING id`,
        [id, domain, hash, demo.agents],
      );
      if (demo.leads)
        await q(
          `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role, on_probation)
           SELECT $1, 'chef' || n || '@' || $2, $3, 'Chef', n::text, 'team_lead', false
           FROM generate_series(1, $4) n`,
          [id, domain, hash, demo.leads],
        );

      // Journées terminées sur les jours ouvrés des 20 derniers jours.
      if (demo.activity && agents.length)
        await q(
          `INSERT INTO work_days (tenant_id, agent_id, status, work_date, started_at, ended_at, end_reason)
           SELECT $1, a.id, 'ended', d::date, d + interval '8 hours', d + interval '16 hours', 'manual'
           FROM generate_series(current_date - 20, current_date - 1, interval '1 day') d
           CROSS JOIN LATERAL (
             SELECT id FROM unnest($2::uuid[]) WITH ORDINALITY AS u(id, i)
             WHERE i <= $3 + (extract(day FROM d)::int % 3)
           ) a
           WHERE extract(isodow FROM d) < 7`,
          [
            id,
            agents.map((a) => a.id),
            Math.min(demo.activity, agents.length - 2),
          ],
        );

      // Factures des mois écoulés depuis la fin de l'essai (14 jours).
      if (demo.status !== 'trialing') {
        const monthly = Math.round(
          ((demo.customPrice ?? PRICES[demo.plan]) *
            (cycle === 'annual' ? 85 : 100)) /
            100,
        );
        const months = Math.max(1, demo.age - 1);
        for (let back = months; back >= 1; back--) {
          const unpaid = back <= (demo.unpaid ?? 0);
          // La plus ancienne facture impayée de la structure suspendue est très en retard.
          const due = unpaid
            ? `date_trunc('month', now()) - interval '${back - 1} months' + interval '${demo.status === 'suspended' ? -20 : -5} days'`
            : `date_trunc('month', now()) - interval '${back - 1} months' + interval '15 days'`;
          await q(
            `INSERT INTO invoices (tenant_id, number, month, plan_code, billing_cycle, agents, base_price,
                                   discount_percent, amount, currency, status, issued_at, due_at,
                                   paid_at, payment_reference, payment_method, recorded_by)
             SELECT $1::uuid, 'F-' || to_char(mo, 'YYYYMM') || '-' || upper(left($1::text, 8)), mo, $2, $3, $4, $5,
                    $6, $7, 'XOF', $8::text, mo + interval '1 month', ${due},
                    CASE WHEN $8 = 'paid' THEN mo + interval '1 month 7 days' END,
                    CASE WHEN $8 = 'paid' THEN 'OM-' || to_char(mo, 'MMYY') || '-' || $9::text END,
                    CASE WHEN $8 = 'paid' THEN 'mobile_money' END,
                    CASE WHEN $8 = 'paid' THEN $10 END
             FROM (SELECT date_trunc('month', now()) - interval '${back} months' AS mo) x`,
            [
              id,
              demo.plan,
              cycle,
              demo.agents,
              demo.customPrice ?? PRICES[demo.plan],
              cycle === 'annual' ? 15 : 0,
              monthly,
              unpaid ? 'pending' : 'paid',
              index,
              DEMO_PLATFORM_ADMIN,
            ],
          );
        }
      }
      if (demo.status === 'suspended')
        await q(
          `INSERT INTO platform_audit (admin_id, action, tenant_id, details)
           SELECT id, 'tenant.note', $1, '{"note": "Relancé par téléphone, paiement promis"}'
           FROM platform_admins WHERE email = $2`,
          [id, DEMO_PLATFORM_ADMIN],
        );
    }
  });
}
