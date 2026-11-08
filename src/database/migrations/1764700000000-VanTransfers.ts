import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vente en camionnette, suite :
 * - dépannage partagé entre camions : une demande (ce qu'il faut à l'agent en rupture),
 *   diffusée aux collègues proches ; chaque collègue prend une part (réservée), remise sur
 *   place avec le code scanné du demandeur (mouvement « transfer » camion → camion) ;
 * - vente d'urgence hors zone : motif gardé sur la vente ;
 * - sortie de zone justifiée (par une vente hors zone).
 */
export class VanTransfers1764700000000 implements MigrationInterface {
  name = 'VanTransfers1764700000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(
      `ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check`,
    );
    await q.query(
      `ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
         CHECK (kind IN ('receipt', 'load', 'unload', 'sale', 'sale_cancel', 'loss', 'adjustment', 'transfer'))`,
    );
    await q.query(`
      CREATE TABLE van_transfers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Identifiant généré sur le téléphone du demandeur (un renvoi ne crée pas de doublon)
        client_id uuid NOT NULL,
        requester_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        requester_van_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'open'
          CHECK (status IN ('open', 'covered', 'done', 'closed', 'expired')),
        -- Ce qu'il faut : [{ productId, quantity }]
        lines jsonb NOT NULL,
        note text,
        -- Code affiché par le demandeur (QR), scanné par chaque collègue à la remise
        token text NOT NULL UNIQUE,
        -- Collègues prévenus (5 plus proches, puis tous à l'élargissement)
        notified uuid[] NOT NULL DEFAULT '{}',
        widened_at timestamptz,
        closed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (requester_id, client_id)
      )`);
    await q.query(`
      CREATE TABLE van_transfer_legs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        transfer_id uuid NOT NULL REFERENCES van_transfers(id) ON DELETE CASCADE,
        giver_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        giver_van_id uuid NOT NULL REFERENCES stock_locations(id) ON DELETE CASCADE,
        status text NOT NULL
          CHECK (status IN ('approval', 'accepted', 'done', 'released', 'rejected')),
        -- Collègue d'une autre équipe : son chef valide avant la remise
        cross_team boolean NOT NULL DEFAULT false,
        -- Part réservée : [{ productId, quantity }]
        lines jsonb NOT NULL,
        decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
        decided_at timestamptz,
        decision_note text,
        -- Début de la réservation (libérée après 1 h sans remise)
        accepted_at timestamptz,
        movement_id uuid REFERENCES stock_movements(id) ON DELETE SET NULL,
        done_at timestamptz,
        release_reason text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX van_transfer_legs_transfer_idx ON van_transfer_legs (transfer_id)`,
    );
    await q.query(
      `CREATE INDEX van_transfers_open_idx ON van_transfers (status) WHERE status IN ('open', 'covered')`,
    );
    for (const table of ['van_transfers', 'van_transfer_legs']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    await q.query(`ALTER TABLE orders ADD COLUMN out_of_zone_reason text`);
    await q.query(`ALTER TABLE zone_exits ADD COLUMN justification text`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE zone_exits DROP COLUMN justification`);
    await q.query(`ALTER TABLE orders DROP COLUMN out_of_zone_reason`);
    await q.query(`DROP TABLE van_transfer_legs`);
    await q.query(`DROP TABLE van_transfers`);
    await q.query(`DELETE FROM stock_movements WHERE kind = 'transfer'`);
    await q.query(
      `ALTER TABLE stock_movements DROP CONSTRAINT stock_movements_kind_check`,
    );
    await q.query(
      `ALTER TABLE stock_movements ADD CONSTRAINT stock_movements_kind_check
         CHECK (kind IN ('receipt', 'load', 'unload', 'sale', 'sale_cancel', 'loss', 'adjustment'))`,
    );
  }
}
