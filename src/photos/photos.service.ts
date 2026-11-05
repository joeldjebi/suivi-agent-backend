import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { FileStorage } from '../common/file-storage';
import { cleanImage, imageMime } from '../common/image';
import type { UploadPhotoDto } from './photos.dto';

/** Taille maximale d'une photo (le téléphone la réduit avant l'envoi). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface PhotoMeta {
  id: string;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  takenAt: Date;
  /** « shelf » : photo de rayon */
  kind: string | null;
  /** État de l'analyse par l'IA photo, s'il y en a une */
  analysis: string | null;
  /** Score du rayon donné par l'IA (analyse terminée) */
  shelfScore: number | null;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Clé du fichier d'une photo dans le dossier de stockage. */
const photoKey = (tenantId: string, id: string, mime: string) =>
  `photos/${tenantId}/${id}.${EXTENSIONS[mime] ?? 'img'}`;

/**
 * Photos géolocalisées des formulaires de mission et des fiches de points de vente. Le
 * contenu est rangé dans le dossier de stockage (FileStorage) ; la base garde la position,
 * l'heure, l'auteur et la clé du fichier.
 */
@Injectable()
export class PhotosService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PhotosService.name);

  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly storage: FileStorage,
  ) {}

  /** Au démarrage, les photos encore dans la base passent dans le dossier (sans attendre). */
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test') return;
    void this.moveLegacyPhotos().catch((error: unknown) =>
      this.logger.error('Copie des anciennes photos interrompue', error),
    );
  }

  /**
   * Recopie dans le dossier les photos enregistrées dans la base, par lots, puis efface leur
   * contenu de la base une fois le fichier relu et vérifié. Rend le nombre de photos copiées.
   */
  async moveLegacyPhotos(batch = 50): Promise<number> {
    let moved = 0;
    for (;;) {
      const rows = await this.db.runAsSystem(() =>
        this.db.manager.query<
          { id: string; tenantId: string; mime: string; data: Buffer }[]
        >(
          `SELECT id, tenant_id AS "tenantId", mime, data FROM submission_photos
           WHERE storage_key IS NULL AND data IS NOT NULL
           ORDER BY created_at LIMIT $1`,
          [batch],
        ),
      );
      if (!rows.length) break;
      for (const row of rows) {
        const key = photoKey(row.tenantId, row.id, row.mime);
        await this.storage.put(key, row.data);
        const copy = await this.storage.get(key);
        if (!copy.equals(row.data))
          throw new Error(`Copie de la photo ${row.id} incorrecte`);
        await this.db.runAsSystem(() =>
          this.db.manager.query(
            `UPDATE submission_photos SET storage_key = $2, data = NULL WHERE id = $1`,
            [row.id, key],
          ),
        );
        moved++;
      }
    }
    if (moved)
      this.logger.log(
        `${moved} photo(s) recopiée(s) dans le dossier de stockage`,
      );
    return moved;
  }

  async upload(
    user: AuthUser,
    file: Express.Multer.File | undefined,
    dto: UploadPhotoDto,
  ): Promise<{ id: string; kind: string | null }> {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id, kind FROM submission_photos WHERE agent_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return existing as { id: string; kind: string | null };
    if (!file?.buffer?.length)
      throw badRequest('PHOTO_REQUIRED', 'Aucune photo reçue');
    if (file.size > MAX_PHOTO_BYTES)
      throw badRequest('PHOTO_TOO_LARGE', 'Photo trop lourde (5 Mo maximum)');
    const mime = imageMime(file.buffer);
    if (!mime)
      throw badRequest(
        'PHOTO_FORMAT',
        'Format non reconnu : JPEG, PNG ou WebP attendu',
      );
    const data = await cleanImage(file.buffer, mime);
    // Le fichier d'abord : la photo n'existe en base qu'une fois son contenu enregistré.
    const id = randomUUID();
    const key = photoKey(this.db.tenantId, id, mime);
    await this.storage.put(key, data);
    const [saved] = await m.query<{ id: string }[]>(
      `INSERT INTO submission_photos
         (id, tenant_id, agent_id, client_id, storage_key, mime, size, lat, lng, accuracy, taken_at, kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (agent_id, client_id) DO UPDATE SET client_id = EXCLUDED.client_id
       RETURNING id`,
      [
        id,
        this.db.tenantId,
        user.id,
        dto.clientId,
        key,
        mime,
        data.length,
        dto.lat ?? null,
        dto.lng ?? null,
        dto.accuracy ?? null,
        dto.takenAt,
        dto.kind ?? null,
      ],
    );
    // Envoi simultané du même cliché : celui déjà enregistré est gardé.
    if (saved.id !== id) await this.storage.remove(key);
    return { id: saved.id, kind: dto.kind ?? null };
  }

  /**
   * L'image : l'agent voit les siennes, le chef celles de ses agents, l'administrateur toutes.
   * Photo d'une fiche de point de vente, ou prise pendant la visite d'un point de vente :
   * toute l'équipe qui voit le point de vente (l'identifiant n'est donné que par la fiche ou
   * par le détail de la visite, qui vérifient cet accès).
   */
  async file(user: AuthUser, id: string) {
    const row = await this.visible(user, id);
    // Photo d'avant le dossier de stockage, pas encore recopiée : encore en base.
    const data = await this.content(row);
    if (!data) throw notFound('Photo');
    return { data, mime: row.mime };
  }

  /** La photo, si l'utilisateur peut la voir (sinon « introuvable »). */
  async visible(user: AuthUser, id: string) {
    const [row] = await this.db.manager.query<
      {
        agentId: string;
        outletId: string | null;
        visitOutletId: string | null;
        reference: boolean;
        data: Buffer | null;
        storageKey: string | null;
        mime: string;
      }[]
    >(
      `SELECT p.agent_id AS "agentId", p.outlet_id AS "outletId",
              s.outlet_id AS "visitOutletId", p.data, p.storage_key AS "storageKey", p.mime,
              EXISTS (SELECT 1 FROM products pr WHERE pr.reference_photo_id = p.id) AS reference
       FROM submission_photos p
       LEFT JOIN mission_submissions s ON s.id = p.submission_id
       WHERE p.id = $1`,
      [id],
    );
    if (!row) throw notFound('Photo');
    if (row.outletId || row.visitOutletId || row.reference) {
      // Fiche ou visite d'un point de vente, photo de référence d'un produit : visible par la
      // structure (RLS).
    } else if (user.role === Role.Agent) {
      if (row.agentId !== user.id) throw notFound('Photo');
    } else if (user.role === Role.TeamLead) {
      await this.access.assertCanManageAgent(user, row.agentId);
    }
    return row;
  }

  /** Contenu d'une photo (dossier de stockage, ou base pour une photo d'avant). */
  async content(row: { data: Buffer | null; storageKey: string | null }) {
    return row.storageKey
      ? await this.storage.get(row.storageKey).catch(() => null)
      : row.data;
  }

  /**
   * Photos d'un formulaire avant son enregistrement : elles doivent exister, appartenir à
   * l'agent et n'être rattachées à aucun autre formulaire.
   */
  async assertUsable(agentId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM submission_photos
       WHERE id = ANY($1::uuid[]) AND agent_id = $2 AND submission_id IS NULL AND outlet_id IS NULL
         AND suggestion_id IS NULL`,
      [ids, agentId],
    );
    if (rows.length !== new Set(ids).size)
      throw badRequest(
        'PHOTO_MISSING',
        'Une photo du formulaire est introuvable : reprenez-la',
      );
  }

  async attach(submissionId: string, ids: string[]) {
    if (!ids.length) return;
    await this.db.manager.query(
      `UPDATE submission_photos SET submission_id = $1 WHERE id = ANY($2::uuid[])`,
      [submissionId, ids],
    );
  }

  /** Position et heure de prise des photos, par identifiant. */
  async meta(ids: string[]): Promise<Record<string, PhotoMeta>> {
    if (!ids.length) return {};
    const rows = await this.db.manager.query<PhotoMeta[]>(
      `SELECT p.id, p.lat, p.lng, p.accuracy, p.taken_at AS "takenAt", p.kind,
              a.status AS analysis,
              CASE WHEN a.status = 'done' THEN (a.result->>'shelfScore')::int END AS "shelfScore"
       FROM submission_photos p LEFT JOIN photo_analyses a ON a.photo_id = p.id
       WHERE p.id = ANY($1::uuid[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }

  /** Supprime une photo (et son fichier) rattachée à rien : ancienne photo de référence. */
  async removeUnused(id: string) {
    const [row] = await this.db.manager.query<{ storageKey: string | null }[]>(
      `DELETE FROM submission_photos p
       WHERE p.id = $1 AND p.submission_id IS NULL AND p.outlet_id IS NULL
         AND p.suggestion_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM products pr WHERE pr.reference_photo_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM outlets o WHERE o.photo_id = p.id)
       RETURNING p.storage_key AS "storageKey"`,
      [id],
    );
    if (row?.storageKey) {
      const key = row.storageKey;
      this.db.afterCommit(() => void this.storage.remove(key).catch(() => {}));
    }
  }
}
