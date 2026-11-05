import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vente en camionnette (fonctionnalité « van_sales », demande la prise de commande) :
 * - emplacements de stock : dépôts et camions (un camion actif par agent au plus) ;
 * - stock par emplacement et par produit, en unités de base ; chaque changement est un
 *   mouvement (entrée, chargement, retour, vente, annulation, perte, inventaire) avec ses lignes ;
 * - ventes directes : des commandes de type « sale », livrées sur place, payées en tout ou
 *   partie (le reste à crédit, dans la limite du plafond du point de vente) ;
 * - paiements reçus, répartis sur les commandes à régler (les plus anciennes d'abord) ;
 * - remises de caisse : l'argent liquide encaissé par l'agent et remis à un responsable.
 */
export class VanSales1764300000000 implements MigrationInterface {
  name = 'VanSales1764300000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;

    await q.query(`
      CREATE TABLE stock_locations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('depot', 'van')),
        name text NOT NULL,
        -- Immatriculation d'un camion
        plate text,
        -- Agent vendeur affecté au camion
        agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK (kind = 'van' OR agent_id IS NULL)
      )`);
    await q.query(
      `CREATE UNIQUE INDEX stock_locations_name_idx ON stock_locations (tenant_id, lower(name))`,
    );
    await q.query(
      `CREATE UNIQUE INDEX stock_locations_agent_idx ON stock_locations (agent_id) WHERE agent_id IS NOT NULL AND is_active`,
    );

    await q.query(`
      CREATE TABLE stock_levels (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        location_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        -- En unités de base ; négatif possible après une vente sans réseau (signalée)
        quantity numeric NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (location_id, product_id)
      )`);

    await q.query(`
      CREATE TABLE stock_movements (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        kind text NOT NULL
          CHECK (kind IN ('receipt', 'load', 'unload', 'sale', 'sale_cancel', 'loss', 'adjustment')),
        status text NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'cancelled')),
        from_location_id uuid REFERENCES stock_locations(id) ON DELETE CASCADE,
        to_location_id uuid REFERENCES stock_locations(id) ON DELETE CASCADE,
        order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
        -- Identifiant généré sur le téléphone : un renvoi ne crée pas de doublon
        client_id uuid,
        note text,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL,
        confirmed_at timestamptz,
        occurred_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (created_by, client_id),
        CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
      )`);
    await q.query(
      `CREATE INDEX stock_movements_tenant_idx ON stock_movements (tenant_id, occurred_at DESC)`,
    );
    await q.query(
      `CREATE INDEX stock_movements_from_idx ON stock_movements (from_location_id, occurred_at DESC)`,
    );
    await q.query(
      `CREATE INDEX stock_movements_to_idx ON stock_movements (to_location_id, occurred_at DESC)`,
    );
    await q.query(
      `CREATE INDEX stock_movements_pending_idx ON stock_movements (tenant_id) WHERE status = 'pending'`,
    );
    await q.query(`
      CREATE TABLE stock_movement_lines (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        movement_id uuid NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        -- Unités de base : positive pour un transfert, signée pour un inventaire (écart)
        quantity numeric NOT NULL CHECK (quantity <> 0),
        -- Quantité réellement reçue à la confirmation (chargement, retour)
        received numeric CHECK (received >= 0)
      )`);
    await q.query(
      `CREATE INDEX stock_movement_lines_movement_idx ON stock_movement_lines (movement_id)`,
    );
    await q.query(
      `CREATE INDEX stock_movement_lines_product_idx ON stock_movement_lines (product_id)`,
    );

    // Ventes directes et paiements partiels sur les commandes.
    await q.query(`
      ALTER TABLE orders
        ADD COLUMN kind text NOT NULL DEFAULT 'order' CHECK (kind IN ('order', 'sale')),
        ADD COLUMN location_id uuid REFERENCES stock_locations(id) ON DELETE SET NULL,
        ADD COLUMN paid_amount numeric NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
        ADD COLUMN flags text[] NOT NULL DEFAULT '{}'`);
    await q.query(
      `UPDATE orders SET paid_amount = total WHERE status = 'paid'`,
    );
    await q.query(
      `CREATE INDEX orders_due_idx ON orders (outlet_id, taken_at) WHERE status = 'delivered'`,
    );
    // Plafond de crédit du point de vente ; vide : pas de vente à crédit.
    await q.query(
      `ALTER TABLE outlets ADD COLUMN credit_limit numeric CHECK (credit_limit >= 0)`,
    );

    await q.query(`
      CREATE TABLE payments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id uuid,
        outlet_id uuid NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
        -- Qui a reçu l'argent (l'agent, pour sa caisse)
        agent_id uuid REFERENCES users(id) ON DELETE SET NULL,
        amount numeric NOT NULL CHECK (amount > 0),
        method text NOT NULL CHECK (method IN ('cash', 'mobile_money', 'bank')),
        note text,
        received_at timestamptz NOT NULL,
        -- Annulé avec sa vente : ne compte plus (ni dans la caisse, ni dans le solde)
        refunded_at timestamptz,
        created_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (created_by, client_id)
      )`);
    await q.query(
      `CREATE INDEX payments_tenant_idx ON payments (tenant_id, received_at DESC)`,
    );
    await q.query(
      `CREATE INDEX payments_agent_idx ON payments (agent_id, received_at DESC)`,
    );
    await q.query(
      `CREATE INDEX payments_outlet_idx ON payments (outlet_id, received_at DESC)`,
    );
    await q.query(`
      CREATE TABLE payment_allocations (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
        order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        amount numeric NOT NULL CHECK (amount > 0),
        PRIMARY KEY (payment_id, order_id)
      )`);
    await q.query(
      `CREATE INDEX payment_allocations_order_idx ON payment_allocations (order_id)`,
    );

    await q.query(`
      CREATE TABLE cash_remittances (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        agent_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount numeric NOT NULL CHECK (amount > 0),
        -- Responsable qui a reçu l'argent
        received_by uuid REFERENCES users(id) ON DELETE SET NULL,
        note text,
        remitted_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX cash_remittances_agent_idx ON cash_remittances (agent_id, remitted_at DESC)`,
    );

    for (const table of [
      'stock_locations',
      'stock_levels',
      'stock_movements',
      'stock_movement_lines',
      'payments',
      'payment_allocations',
      'cash_remittances',
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
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE cash_remittances`);
    await q.query(`DROP TABLE payment_allocations`);
    await q.query(`DROP TABLE payments`);
    await q.query(`ALTER TABLE outlets DROP COLUMN credit_limit`);
    await q.query(`DROP INDEX orders_due_idx`);
    await q.query(
      `ALTER TABLE orders DROP COLUMN kind, DROP COLUMN location_id, DROP COLUMN paid_amount, DROP COLUMN flags`,
    );
    await q.query(`DROP TABLE stock_movement_lines`);
    await q.query(`DROP TABLE stock_movements`);
    await q.query(`DROP TABLE stock_levels`);
    await q.query(`DROP TABLE stock_locations`);
  }
}
