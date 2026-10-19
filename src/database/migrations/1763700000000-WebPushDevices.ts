import { MigrationInterface, QueryRunner } from 'typeorm';

/** Notifications push de la version web (navigateur) : appareils « web » acceptés. */
export class WebPushDevices1763700000000 implements MigrationInterface {
  name = 'WebPushDevices1763700000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE push_devices DROP CONSTRAINT IF EXISTS push_devices_platform_check`,
    );
    await q.query(
      `ALTER TABLE push_devices ADD CONSTRAINT push_devices_platform_check CHECK (platform IN ('android', 'ios', 'web'))`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DELETE FROM push_devices WHERE platform = 'web'`);
    await q.query(
      `ALTER TABLE push_devices DROP CONSTRAINT IF EXISTS push_devices_platform_check`,
    );
    await q.query(
      `ALTER TABLE push_devices ADD CONSTRAINT push_devices_platform_check CHECK (platform IN ('android', 'ios'))`,
    );
  }
}
