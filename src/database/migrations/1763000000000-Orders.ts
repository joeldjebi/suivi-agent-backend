import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prise de commande terrain (fonctionnalité « orders », demande les points de vente) :
 * - types de client (listes de tarifs : Grossiste, Détaillant…) définis par la structure, l'un
 *   d'eux par défaut ; chaque point de vente peut en recevoir un ;
 * - prix de vente par type de client et par produit, en unité de base ;
 * - commandes prises par l'agent (prix figés à la prise), leurs lignes et l'historique des
 *   statuts : prise → livrée → payée, ou annulée.
 */
export class Orders1763000000000 implements MigrationInterface {
  name = 'Orders1763000000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`
      CREATE TABLE price_lists (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name text NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE UNIQUE INDEX price_lists_name_idx ON price_lists (tenant_id, lower(name))`,
    );
    // Un seul type de client par défaut par structure.
    await q.query(
      `CREATE UNIQUE INDEX price_lists_default_idx ON price_lists (tenant_id) WHERE is_default`,
    );
    await q.query(`
      CREATE TABLE product_prices (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        price_list_id uuid NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        -- Prix d'une unité de base (bouteille, sachet…)
        price numeric NOT NULL CHECK (price >= 0),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (price_list_id, product_id)
      )`);
    await q.query(
      `ALTER TABLE outlets ADD COLUMN price_list_id uuid REFERENCES price_lists(id) ON DELETE SET NULL`,
    );
    await q.query(`
      CREATE TABLE orders (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Numéro lisible, propre à la structure (CMD-000042)
        number integer NOT NULL,
        -- Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon
        client_id uuid NOT NULL,
        outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        price_list_id uuid REFERENCES price_lists(id) ON DELETE SET NULL,
        price_list_name text,
        status text NOT NULL DEFAULT 'taken'
          CHECK (status IN ('taken', 'delivered', 'paid', 'cancelled')),
        total numeric NOT NULL DEFAULT 0,
        currency text NOT NULL DEFAULT 'XOF',
        note text,
        lat double precision,
        lng double precision,
        distance_m integer,
        taken_at timestamptz NOT NULL,
        delivered_at timestamptz,
        paid_at timestamptz,
        cancelled_at timestamptz,
        cancel_reason text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, number),
        UNIQUE (agent_id, client_id)
      )`);
    await q.query(
      `CREATE INDEX orders_tenant_idx ON orders (tenant_id, taken_at DESC)`,
    );
    await q.query(
      `CREATE INDEX orders_outlet_idx ON orders (outlet_id, taken_at DESC)`,
    );
    await q.query(
      `CREATE INDEX orders_agent_idx ON orders (agent_id, taken_at DESC)`,
    );
    await q.query(`
      CREATE TABLE order_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        -- Libellé et unité au moment de la commande
        product_name text NOT NULL,
        unit text NOT NULL,
        -- En unités de base
        quantity numeric NOT NULL CHECK (quantity > 0),
        unit_price numeric NOT NULL,
        amount numeric NOT NULL,
        position integer NOT NULL
      )`);
    await q.query(
      `CREATE INDEX order_lines_order_idx ON order_lines (order_id, position)`,
    );
    await q.query(
      `CREATE INDEX order_lines_product_idx ON order_lines (product_id)`,
    );
    await q.query(`
      CREATE TABLE order_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        status text NOT NULL,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        comment text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX order_events_order_idx ON order_events (order_id, created_at)`,
    );
    for (const table of [
      'price_lists',
      'product_prices',
      'orders',
      'order_lines',
      'order_events',
    ]) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    await q.query(`
      UPDATE plans SET features = array_append(features, 'orders')
      WHERE code = 'enterprise' AND NOT ('orders' = ANY(features))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(
      `UPDATE plans SET features = array_remove(features, 'orders')`,
    );
    await q.query(`DROP TABLE order_events`);
    await q.query(`DROP TABLE order_lines`);
    await q.query(`DROP TABLE orders`);
    await q.query(`ALTER TABLE outlets DROP COLUMN price_list_id`);
    await q.query(`DROP TABLE product_prices`);
    await q.query(`DROP TABLE price_lists`);
  }
}
