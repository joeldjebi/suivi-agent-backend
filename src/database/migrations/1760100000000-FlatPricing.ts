import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Formules au forfait : un prix mensuel global avec un quota de chefs d'équipe et d'agents,
 * et des agents supplémentaires achetés au-delà. Montants provisoires (réglés par l'éditeur).
 */
export class FlatPricing1760100000000 implements MigrationInterface {
  name = 'FlatPricing1760100000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE plans
        ADD COLUMN monthly_price integer NOT NULL DEFAULT 0,
        ADD COLUMN included_agents integer NOT NULL DEFAULT 0,
        ADD COLUMN included_leads integer NOT NULL DEFAULT 0,
        ADD COLUMN extra_agent_price integer NOT NULL DEFAULT 0`);
    await q.query(`
      UPDATE plans SET monthly_price = v.price, included_agents = v.agents,
                       included_leads = v.leads, extra_agent_price = v.extra
      FROM (VALUES ('base', 5000, 10, 1, 500),
                   ('advanced', 15000, 30, 3, 450),
                   ('enterprise', 40000, 100, 10, 400)) AS v(code, price, agents, leads, extra)
      WHERE plans.code = v.code`);
    await q.query(`ALTER TABLE plans DROP COLUMN price_per_agent`);

    await q.query(
      `ALTER TABLE subscriptions ADD COLUMN extra_agents integer NOT NULL DEFAULT 0`,
    );

    // Factures : forfait + agents supplémentaires (au prorata si l'essai finit en cours de mois).
    await q.query(`
      ALTER TABLE invoices
        ADD COLUMN base_price integer NOT NULL DEFAULT 0,
        ADD COLUMN extra_agents integer NOT NULL DEFAULT 0,
        ADD COLUMN extra_agent_price integer NOT NULL DEFAULT 0,
        ADD COLUMN prorata_percent integer NOT NULL DEFAULT 100`);
    await q.query(`UPDATE invoices SET base_price = amount`);
    await q.query(`ALTER TABLE invoices DROP COLUMN unit_price`);
    await q.query(`ALTER TABLE invoices RENAME COLUMN active_agents TO agents`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE invoices RENAME COLUMN agents TO active_agents`);
    await q.query(
      `ALTER TABLE invoices ADD COLUMN unit_price integer NOT NULL DEFAULT 0`,
    );
    await q.query(`
      ALTER TABLE invoices
        DROP COLUMN base_price, DROP COLUMN extra_agents,
        DROP COLUMN extra_agent_price, DROP COLUMN prorata_percent`);
    await q.query(`ALTER TABLE subscriptions DROP COLUMN extra_agents`);
    await q.query(
      `ALTER TABLE plans ADD COLUMN price_per_agent integer NOT NULL DEFAULT 0`,
    );
    await q.query(`
      ALTER TABLE plans
        DROP COLUMN monthly_price, DROP COLUMN included_agents,
        DROP COLUMN included_leads, DROP COLUMN extra_agent_price`);
  }
}
