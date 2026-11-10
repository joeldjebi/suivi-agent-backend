import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Filet de sécurité pour push_devices : la table portait tenant_id + user_id mais, seule
 * parmi les tables de structure, n'avait pas de Row Level Security (l'isolation reposait
 * uniquement sur le filtre applicatif). On ajoute la même politique que partout ailleurs,
 * pour qu'une future requête qui oublierait le filtre ne puisse pas fuiter entre structures.
 */
export class PushDevicesRls1765100000000 implements MigrationInterface {
  name = 'PushDevicesRls1765100000000';

  public async up(q: QueryRunner): Promise<void> {
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(`ALTER TABLE push_devices ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE push_devices FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON push_devices USING (${policy}) WITH CHECK (${policy})`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY IF EXISTS tenant_isolation ON push_devices`);
    await q.query(`ALTER TABLE push_devices NO FORCE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE push_devices DISABLE ROW LEVEL SECURITY`);
  }
}
