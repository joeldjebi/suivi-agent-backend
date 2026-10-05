import { MigrationInterface, QueryRunner } from 'typeorm';

/** Date du rejet d'un formulaire (fil d'actions du chef d'équipe). */
export class SubmissionRejectedAt1759900000000 implements MigrationInterface {
  name = 'SubmissionRejectedAt1759900000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(
      `ALTER TABLE mission_submissions ADD COLUMN rejected_at timestamptz`,
    );
    // Rejets antérieurs : date inconnue, on reprend la date de réception.
    await q.query(
      `UPDATE mission_submissions SET rejected_at = received_at WHERE status = 'rejected'`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE mission_submissions DROP COLUMN rejected_at`);
  }
}
