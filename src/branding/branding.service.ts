import { Injectable } from '@nestjs/common';
import { imageMime } from '../common/image';
import { badRequest, notFound } from '../common/business.exception';
import { DbService } from '../common/db.service';
import { Feature } from '@suivi/shared';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';

/** Couleur de l'apparence neutre (celle de la plateforme). */
const DEFAULT_PRIMARY = '#2563EB';
import { Tenant, TenantBranding } from '../entities';
import { BrandingDto, UpdateBrandingDto } from './branding.dto';

export const MAX_LOGO_BYTES = 512 * 1024;

/** Signatures des formats acceptés (le type annoncé par le client ne suffit pas). */

const DARK_TEXT = '#0F172A';

/** Contraste WCAG entre deux couleurs #RRGGBB. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Texte blanc ou foncé, selon ce qui est le plus lisible sur la couleur. */
export function readableOn(color: string): string {
  return contrast(color, '#FFFFFF') >= contrast(color, DARK_TEXT)
    ? '#FFFFFF'
    : DARK_TEXT;
}

@Injectable()
export class BrandingService {
  constructor(
    private readonly db: DbService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** L'apparence personnalisée n'est servie que si la formule l'inclut. */
  private async customized(): Promise<boolean> {
    const { features } = await this.subscriptions.summary(this.db.tenantId);
    return features.includes(Feature.Branding);
  }

  async get(): Promise<BrandingDto> {
    const m = this.db.manager;
    const tenantId = this.db.tenantId;
    await m.query(
      `INSERT INTO tenant_branding (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [tenantId],
    );
    const [branding, tenant] = [
      await m.findOneByOrFail(TenantBranding, { tenantId }),
      await m.findOneByOrFail(Tenant, { id: tenantId }),
    ];
    // Sans l'avantage, l'app garde l'apparence neutre (le nom de la structure seulement).
    if (!(await this.customized()))
      return {
        displayName: tenant.name,
        primaryColor: DEFAULT_PRIMARY,
        onPrimaryColor: readableOn(DEFAULT_PRIMARY),
        welcomeMessage: null,
        supportPhone: branding.supportPhone,
        logoUrl: null,
        // Version distincte : l'app abandonne l'apparence personnalisée qu'elle avait en cache.
        version: 0,
      };
    return {
      displayName: branding.displayName || tenant.name,
      primaryColor: branding.primaryColor,
      onPrimaryColor: readableOn(branding.primaryColor),
      welcomeMessage: branding.welcomeMessage,
      supportPhone: branding.supportPhone,
      logoUrl: branding.logoMime
        ? `/api/branding/logo?v=${branding.version}`
        : null,
      version: branding.version,
    };
  }

  async update(dto: UpdateBrandingDto): Promise<BrandingDto> {
    await this.get();
    const clean = (v: string | null | undefined) =>
      v === undefined ? undefined : v?.trim() || null;
    await this.db.manager
      .createQueryBuilder()
      .update(TenantBranding)
      .set({
        ...(dto.displayName !== undefined
          ? { displayName: clean(dto.displayName) }
          : {}),
        ...(dto.primaryColor
          ? { primaryColor: dto.primaryColor.toUpperCase() }
          : {}),
        ...(dto.welcomeMessage !== undefined
          ? { welcomeMessage: clean(dto.welcomeMessage) }
          : {}),
        ...(dto.supportPhone !== undefined
          ? { supportPhone: clean(dto.supportPhone) }
          : {}),
        version: () => 'version + 1',
      })
      .where('tenant_id = :tenantId', { tenantId: this.db.tenantId })
      .execute();
    return this.get();
  }

  async setLogo(file: Express.Multer.File | undefined): Promise<BrandingDto> {
    if (!file?.buffer?.length)
      throw badRequest(
        'LOGO_REQUIRED',
        'Envoyez une image dans le champ « file »',
      );
    if (file.size > MAX_LOGO_BYTES)
      throw badRequest('LOGO_TOO_LARGE', 'Le logo ne doit pas dépasser 512 Ko');
    const mime = imageMime(file.buffer);
    if (!mime)
      throw badRequest('LOGO_FORMAT', 'Formats acceptés : PNG, JPEG ou WebP');
    await this.get();
    await this.db.manager.query(
      `UPDATE tenant_branding SET logo = $2, logo_mime = $3, version = version + 1, updated_at = now() WHERE tenant_id = $1`,
      [this.db.tenantId, file.buffer, mime],
    );
    return this.get();
  }

  async deleteLogo(): Promise<BrandingDto> {
    await this.db.manager.query(
      `UPDATE tenant_branding SET logo = NULL, logo_mime = NULL, version = version + 1, updated_at = now() WHERE tenant_id = $1`,
      [this.db.tenantId],
    );
    return this.get();
  }

  async logo(): Promise<{ data: Buffer; mime: string; version: number }> {
    if (!(await this.customized())) throw notFound('Logo');
    const [row] = await this.db.manager.query<
      { logo: Buffer | null; logo_mime: string | null; version: number }[]
    >(
      `SELECT logo, logo_mime, version FROM tenant_branding WHERE tenant_id = $1`,
      [this.db.tenantId],
    );
    if (!row?.logo || !row.logo_mime) throw notFound('Logo');
    return { data: row.logo, mime: row.logo_mime, version: row.version };
  }
}
