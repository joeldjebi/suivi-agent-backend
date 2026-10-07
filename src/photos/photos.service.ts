import { Injectable } from '@nestjs/common';
import { Role } from '@suivi/shared';
import { AccessService } from '../common/access.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { imageMime } from '../common/image';
import type { UploadPhotoDto } from './photos.dto';

/** Taille maximale d'une photo (le téléphone la réduit avant l'envoi). */
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export interface PhotoMeta {
  id: string;
  lat: number | null;
  lng: number | null;
  accuracy: number | null;
  takenAt: Date;
}

/** Photos géolocalisées des formulaires de mission. */
@Injectable()
export class PhotosService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
  ) {}

  async upload(
    user: AuthUser,
    file: Express.Multer.File | undefined,
    dto: UploadPhotoDto,
  ): Promise<{ id: string }> {
    const m = this.db.manager;
    const [existing] = await m.query<{ id: string }[]>(
      `SELECT id FROM submission_photos WHERE agent_id = $1 AND client_id = $2`,
      [user.id, dto.clientId],
    );
    if (existing) return existing;
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
    const [saved] = await m.query<{ id: string }[]>(
      `INSERT INTO submission_photos
         (tenant_id, agent_id, client_id, data, mime, size, lat, lng, accuracy, taken_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (agent_id, client_id) DO UPDATE SET client_id = EXCLUDED.client_id
       RETURNING id`,
      [
        this.db.tenantId,
        user.id,
        dto.clientId,
        file.buffer,
        mime,
        file.size,
        dto.lat ?? null,
        dto.lng ?? null,
        dto.accuracy ?? null,
        dto.takenAt,
      ],
    );
    return saved;
  }

  /** L'image : l'agent voit les siennes, le chef celles de ses agents, l'administrateur toutes. */
  async file(user: AuthUser, id: string) {
    const [row] = await this.db.manager.query<
      { agentId: string; data: Buffer; mime: string }[]
    >(
      `SELECT agent_id AS "agentId", data, mime FROM submission_photos WHERE id = $1`,
      [id],
    );
    if (!row) throw notFound('Photo');
    if (user.role === Role.Agent) {
      if (row.agentId !== user.id) throw notFound('Photo');
    } else if (user.role === Role.TeamLead) {
      await this.access.assertCanManageAgent(user, row.agentId);
    }
    return { data: row.data, mime: row.mime };
  }

  /**
   * Photos d'un formulaire avant son enregistrement : elles doivent exister, appartenir à
   * l'agent et n'être rattachées à aucun autre formulaire.
   */
  async assertUsable(agentId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await this.db.manager.query<{ id: string }[]>(
      `SELECT id FROM submission_photos
       WHERE id = ANY($1::uuid[]) AND agent_id = $2 AND submission_id IS NULL`,
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
      `SELECT id, lat, lng, accuracy, taken_at AS "takenAt"
       FROM submission_photos WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((r) => [r.id, r]));
  }
}
