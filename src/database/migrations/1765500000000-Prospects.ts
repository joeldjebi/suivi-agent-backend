import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Prospection commerciale (démarchage sortant) de l'éditeur : entreprises à contacter,
 * leurs infos de contact, statut d'avancement, et modèles de message (e-mail / WhatsApp).
 * Tables de plateforme (pas de tenant) : lues et écrites uniquement par l'éditeur.
 */
export class Prospects1765500000000 implements MigrationInterface {
  name = 'Prospects1765500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE prospects (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        entreprise text NOT NULL,
        secteur text,
        pays text,
        ville text,
        contact_nom text,
        telephone text,
        email text,
        canal text,
        statut text NOT NULL DEFAULT 'a_contacter',
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(
      `CREATE INDEX prospects_statut_idx ON prospects (statut, created_at DESC)`,
    );

    await q.query(`
      CREATE TABLE prospect_templates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        canal text NOT NULL,
        objet text,
        corps text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);

    // Modèles par défaut (modifiables ensuite dans la console). Variables : {{entreprise}}, {{contact}}.
    await q.query(
      `INSERT INTO prospect_templates (canal, objet, corps) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [
        'email',
        'PerformX — suivi de vos équipes de terrain en temps réel',
        `Bonjour {{contact}},

Je me permets de vous contacter au sujet de {{entreprise}}. PerformX est une solution de suivi des équipes de terrain en temps réel : géolocalisation des agents, planification des visites, missions avec preuves (photos, position), et tableaux de bord pour les responsables.

Pour une structure comme la vôtre, cela permet de savoir où sont les agents, de fiabiliser les tournées et de suivre le travail terrain depuis un simple téléphone.

Une courte vidéo de présentation (1 min) : https://performx.online/video

Seriez-vous disponible 15 minutes cette semaine ou la semaine prochaine pour une démonstration ?

Bien cordialement,`,
        'whatsapp',
        null,
        `Bonjour {{contact}}, ici [Votre nom] de PerformX. Nous aidons les structures comme {{entreprise}} à suivre leurs équipes de terrain en temps réel (géolocalisation, visites, missions avec preuves). Courte vidéo : https://performx.online/video — auriez-vous 15 min pour une démo ?`,
      ],
    );

    // L'API se connecte avec un rôle non-propriétaire (RLS) : on lui donne les droits.
    const appUser = process.env.DATABASE_APP_USER ?? 'suivi_app';
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON prospects TO ${appUser}`,
    );
    await q.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON prospect_templates TO ${appUser}`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE prospect_templates`);
    await q.query(`DROP TABLE prospects`);
  }
}
