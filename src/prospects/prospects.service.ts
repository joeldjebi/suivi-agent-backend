import { Injectable, NotFoundException } from '@nestjs/common';
import { Prospect, ProspectTemplate } from '../entities';
import { DbService } from '../common/db.service';
import {
  ListProspectsDto,
  SaveProspectDto,
  UpdateProspectDto,
  UpdateTemplateDto,
} from './prospects.dto';

/**
 * Prospection sortante de l'éditeur. Tables de plateforme (pas de tenant) : on lit et écrit
 * en contournant la RLS (runAsSystem), comme le journal de sécurité.
 */
@Injectable()
export class ProspectsService {
  constructor(private readonly db: DbService) {}

  async list(query: ListProspectsDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    return this.db.runAsSystem(async () => {
      const qb = this.db.manager
        .createQueryBuilder(Prospect, 'p')
        .orderBy('p.prioritaire', 'DESC')
        .addOrderBy('p.updated_at', 'DESC')
        .skip((page - 1) * limit)
        .take(limit);
      if (query.statut) qb.andWhere('p.statut = :statut', { statut: query.statut });
      if (query.pays) qb.andWhere('p.pays = :pays', { pays: query.pays });
      if (query.search)
        qb.andWhere(
          '(p.entreprise ILIKE :q OR p.contact_nom ILIKE :q OR p.ville ILIKE :q OR p.secteur ILIKE :q)',
          { q: `%${query.search}%` },
        );
      const [items, total] = await qb.getManyAndCount();

      const statutRows = await this.db.manager.query<{ statut: string; n: string }[]>(
        `SELECT statut, count(*)::int AS n FROM prospects GROUP BY statut`,
      );
      const counts: Record<string, number> = {};
      for (const r of statutRows) counts[r.statut] = Number(r.n);

      const paysRows = await this.db.manager.query<{ pays: string }[]>(
        `SELECT DISTINCT pays FROM prospects WHERE pays IS NOT NULL ORDER BY pays`,
      );
      const paysListe = paysRows.map((r) => r.pays);

      return { items, total, page, limit, counts, paysListe };
    });
  }

  create(dto: SaveProspectDto) {
    return this.db.runAsSystem(() => this.db.manager.save(Prospect, { ...dto }));
  }

  async update(id: string, dto: UpdateProspectDto) {
    return this.db.runAsSystem(async () => {
      const existing = await this.db.manager.findOneBy(Prospect, { id });
      if (!existing) throw new NotFoundException('Prospect introuvable');
      const merged = { ...existing, ...dto } as Prospect;
      // Dernier contact : renseigné dès qu'on passe à un statut « contacté ».
      if (dto.statut && dto.statut !== 'a_contacter' && dto.statut !== existing.statut) {
        merged.dernierContact = new Date();
      }
      return this.db.manager.save(Prospect, merged);
    });
  }

  async remove(id: string) {
    await this.db.runAsSystem(() => this.db.manager.delete(Prospect, { id }));
  }

  templates() {
    return this.db.runAsSystem(() =>
      this.db.manager.find(ProspectTemplate, { order: { canal: 'ASC' } }),
    );
  }

  async updateTemplate(id: string, dto: UpdateTemplateDto) {
    return this.db.runAsSystem(async () => {
      const existing = await this.db.manager.findOneBy(ProspectTemplate, { id });
      if (!existing) throw new NotFoundException('Modèle introuvable');
      return this.db.manager.save(ProspectTemplate, {
        ...existing,
        objet: dto.objet ?? existing.objet,
        corps: dto.corps,
      });
    });
  }
}
