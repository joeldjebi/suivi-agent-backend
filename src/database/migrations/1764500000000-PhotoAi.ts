import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * IA photo (fonctionnalité « photo_ai ») : les photos de rayon sont analysées en arrière-plan
 * par un modèle de vision (produits présents, faces, prix lus, score du rayon).
 * - submission_photos.kind : « shelf » pour une photo de rayon ;
 * - photo_analyses : une analyse par photo (file d'attente, résultat, coût, essais) ;
 * - photo_ai_bonuses : photos en plus du quota de la formule, accordées par l'éditeur pour un
 *   mois donné ;
 * - products.reference_photo_id : photo de référence d'un produit (aide l'IA) ;
 * - tenant_settings.photo_ai_auto : analyse automatique des photos de rayon (oui par défaut).
 */
export class PhotoAi1764500000000 implements MigrationInterface {
  name = 'PhotoAi1764500000000';

  public async up(q: QueryRunner): Promise<void> {
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    const policy = `current_setting('app.bypass_rls', true) = 'on'
      OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid`;
    await q.query(
      `ALTER TABLE submission_photos ADD COLUMN kind text CHECK (kind IN ('shelf'))`,
    );
    await q.query(`
      CREATE TABLE photo_analyses (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        photo_id uuid NOT NULL UNIQUE REFERENCES submission_photos(id) ON DELETE CASCADE,
        status text NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
        -- Pourquoi une photo n'a pas été analysée (quota épuisé, IA non configurée…)
        skip_reason text,
        provider text,
        model text,
        result jsonb,
        input_tokens integer,
        output_tokens integer,
        cost_usd numeric,
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        error text,
        requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        analyzed_at timestamptz
      )`);
    await q.query(
      `CREATE INDEX photo_analyses_queue_idx ON photo_analyses (next_attempt_at) WHERE status = 'pending'`,
    );
    await q.query(
      `CREATE INDEX photo_analyses_month_idx ON photo_analyses (tenant_id, created_at)`,
    );
    await q.query(`
      CREATE TABLE photo_ai_bonuses (
        tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        -- Mois concerné, « 2026-11 »
        month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
        photos integer NOT NULL CHECK (photos >= 0),
        note text,
        granted_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, month)
      )`);
    for (const table of ['photo_analyses', 'photo_ai_bonuses']) {
      await q.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await q.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await q.query(
        `CREATE POLICY tenant_isolation ON ${table} USING (${policy}) WITH CHECK (${policy})`,
      );
      await q.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO ${appUser}`,
      );
    }
    await q.query(
      `ALTER TABLE products ADD COLUMN reference_photo_id uuid REFERENCES submission_photos(id) ON DELETE SET NULL`,
    );
    await q.query(
      `ALTER TABLE tenant_settings ADD COLUMN photo_ai_auto boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE tenant_settings DROP COLUMN photo_ai_auto`);
    await q.query(`ALTER TABLE products DROP COLUMN reference_photo_id`);
    await q.query(`DROP TABLE photo_ai_bonuses`);
    await q.query(`DROP TABLE photo_analyses`);
    await q.query(`ALTER TABLE submission_photos DROP COLUMN kind`);
  }
}
