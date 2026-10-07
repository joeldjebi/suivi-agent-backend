import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chaque mission se fait dans une ou plusieurs zones ; l'agent voit les missions de la zone
 * qu'il choisit. Une mission peut aussi n'être assignée à personne : elle est alors ouverte
 * à tous les agents qui travaillent dans ses zones. Les formulaires sont envoyés pendant une
 * journée dans une zone de la mission (réglable), et signalés s'ils sont saisis hors zone.
 */
export class MissionZones1761500000000 implements MigrationInterface {
  name = 'MissionZones1761500000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    // Reprise des missions existantes : toutes les structures.
    await q.query(`SELECT set_config('app.bypass_rls', 'on', true)`);

    await q.query(`
      CREATE TABLE mission_zones (
        mission_id uuid NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
        zone_id uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        PRIMARY KEY (mission_id, zone_id)
      )`);
    await q.query(
      `CREATE INDEX mission_zones_zone_idx ON mission_zones (zone_id)`,
    );
    await q.query(`ALTER TABLE mission_zones ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE mission_zones FORCE ROW LEVEL SECURITY`);
    await q.query(
      `CREATE POLICY tenant_isolation ON mission_zones USING (${policy}) WITH CHECK (${policy})`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON mission_zones TO ${appUser}`,
    );

    // Mission ouverte : ni agent ni groupe.
    await q.query(`ALTER TABLE missions DROP CONSTRAINT missions_check`);
    await q.query(`
      ALTER TABLE missions ADD CONSTRAINT missions_assignee_check
        CHECK (assignee_agent_id IS NULL OR assignee_group_id IS NULL)`);

    await q.query(`
      ALTER TABLE tenant_settings
        ADD COLUMN submission_requires_day boolean NOT NULL DEFAULT true`);
    await q.query(`
      ALTER TABLE mission_submissions
        ADD COLUMN zone_id uuid REFERENCES zones(id) ON DELETE SET NULL,
        ADD COLUMN out_of_zone boolean NOT NULL DEFAULT false`);
    // Zone de la journée des formulaires déjà reçus.
    await q.query(`
      UPDATE mission_submissions s SET zone_id = d.zone_id
      FROM work_days d WHERE d.id = s.day_id`);

    // Zones des missions existantes, par ordre de préférence :
    // 1. les zones du groupe assigné ;
    await q.query(`
      INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
      SELECT m.id, gz.zone_id, m.tenant_id
      FROM missions m JOIN group_zones gz ON gz.group_id = m.assignee_group_id
      ON CONFLICT DO NOTHING`);
    // 2. les zones où des formulaires ont déjà été saisis ;
    await q.query(`
      INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
      SELECT DISTINCT m.id, s.zone_id, m.tenant_id
      FROM missions m JOIN mission_submissions s ON s.mission_id = m.id
      WHERE s.zone_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
      ON CONFLICT DO NOTHING`);
    // 3. les zones du groupe de l'agent assigné ;
    await q.query(`
      INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
      SELECT m.id, gz.zone_id, m.tenant_id
      FROM missions m JOIN users u ON u.id = m.assignee_agent_id
      JOIN group_zones gz ON gz.group_id = u.group_id
      WHERE NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
      ON CONFLICT DO NOTHING`);
    // 4. à défaut, toutes les zones actives de la structure.
    await q.query(`
      INSERT INTO mission_zones (mission_id, zone_id, tenant_id)
      SELECT m.id, z.id, m.tenant_id
      FROM missions m JOIN zones z ON z.tenant_id = m.tenant_id AND z.is_active
      WHERE NOT EXISTS (SELECT 1 FROM mission_zones mz WHERE mz.mission_id = m.id)
      ON CONFLICT DO NOTHING`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`SELECT set_config('app.bypass_rls', 'on', true)`);
    await q.query(`
      ALTER TABLE mission_submissions DROP COLUMN zone_id, DROP COLUMN out_of_zone`);
    await q.query(
      `ALTER TABLE tenant_settings DROP COLUMN submission_requires_day`,
    );
    await q.query(
      `DELETE FROM missions WHERE assignee_agent_id IS NULL AND assignee_group_id IS NULL`,
    );
    await q.query(
      `ALTER TABLE missions DROP CONSTRAINT missions_assignee_check`,
    );
    await q.query(`
      ALTER TABLE missions ADD CONSTRAINT missions_check
        CHECK ((assignee_agent_id IS NULL) <> (assignee_group_id IS NULL))`);
    await q.query(`DROP TABLE mission_zones`);
  }
}
