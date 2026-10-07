import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role } from '@suivi/shared';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { IsNull } from 'typeorm';
import type { AuthUser } from '../common/auth-user';
import {
  BusinessException,
  badRequest,
  conflict,
} from '../common/business.exception';
import { DbService } from '../common/db.service';
import { effectiveSettings } from '../common/access.service';
import { SessionRevocationService } from '../common/session-revocation.service';
import { imageMime } from '../common/image';
import { normalizePhone } from '../common/phone';
import { workDate } from '../common/time.util';
import {
  AuditLog,
  RefreshToken,
  Tenant,
  TenantSettings,
  User,
} from '../entities';
import {
  ChangePasswordDto,
  LoginDto,
  RegisterDto,
  TokensDto,
  UpdateProfileDto,
} from './auth.dto';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { JwtPayload } from './jwt.strategy';
import { AccessService } from '../common/access.service';

const REFRESH_TOKEN_DAYS = 30;
const BCRYPT_ROUNDS = 10;

const invalidCredentials = () =>
  new BusinessException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CREDENTIALS',
    'Email ou mot de passe incorrect',
  );

const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');

/** Taille maximale d'une photo de profil (l'app la réduit avant l'envoi). */
export const MAX_AVATAR_BYTES = 1024 * 1024;

export const hashPassword = (password: string) =>
  bcrypt.hash(password, BCRYPT_ROUNDS);

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly revocation: SessionRevocationService,
    private readonly subscriptions: SubscriptionsService,
    private readonly access: AccessService,
  ) {}

  /** Inscription d'une structure : création de son espace et de son administrateur. */
  async register(dto: RegisterDto): Promise<TokensDto> {
    return this.issueTokens(await this.createTenant(dto));
  }

  /**
   * Espace d'une nouvelle structure (réglages, essai gratuit, apparence) et son administrateur.
   * Utilisé par l'inscription et par l'éditeur (espace plateforme).
   */
  async createTenant(
    dto: RegisterDto & { contactPhone?: string | null },
  ): Promise<User> {
    const m = this.db.manager;
    await this.assertEmailFree(dto.email);

    const tenant = await m.save(Tenant, {
      name: dto.organizationName,
      contactPhone: dto.contactPhone ?? null,
    });
    await m.insert(TenantSettings, { tenantId: tenant.id });
    await this.subscriptions.startTrial(tenant.id);
    await m.query(`INSERT INTO tenant_branding (tenant_id) VALUES ($1)`, [
      tenant.id,
    ]);
    const settings = await m.findOneByOrFail(TenantSettings, {
      tenantId: tenant.id,
    });
    // La première remise à zéro aura lieu à la prochaine date de travail.
    await m.update(
      TenantSettings,
      { tenantId: tenant.id },
      {
        lastResetDate: workDate(
          new Date(),
          settings.timezone,
          settings.dailyResetTime,
        ),
      },
    );

    const admin = await m.save(User, {
      tenantId: tenant.id,
      email: dto.email.toLowerCase(),
      passwordHash: await hashPassword(dto.password),
      firstName: dto.firstName,
      lastName: dto.lastName,
      role: Role.Admin,
      onProbation: false,
      isActive: true,
    });
    await m.insert(AuditLog, {
      tenantId: tenant.id,
      userId: admin.id,
      action: 'auth.register',
    });
    return admin;
  }

  async login(dto: LoginDto, ip?: string): Promise<TokensDto> {
    const m = this.db.manager;
    const qb = m.createQueryBuilder(User, 'u').addSelect('u.passwordHash');
    const phone = dto.phone ? normalizePhone(dto.phone) : null;
    if (dto.phone) {
      qb.where('u.phone = :phone', { phone: phone ?? '' });
    } else {
      qb.where('lower(u.email) = lower(:email)', { email: dto.email });
    }
    const user = await qb.getOne();

    const valid =
      !!user &&
      user.isActive &&
      (await bcrypt.compare(dto.password, user.passwordHash));
    const entry = {
      tenantId: user?.tenantId ?? null,
      userId: user?.id ?? null,
      action: valid ? 'auth.login' : 'auth.login_failed',
      ip: ip ?? null,
    };
    if (!valid) {
      // Transaction séparée : celle de la requête est annulée par l'erreur.
      await this.db.runAsSystem(() => this.db.manager.insert(AuditLog, entry));
      throw invalidCredentials();
    }
    await m.insert(AuditLog, entry);
    return this.issueTokens(user);
  }

  /** Rotation : l'ancien jeton de rafraîchissement est révoqué à chaque utilisation. */
  async refresh(refreshToken: string): Promise<TokensDto> {
    const m = this.db.manager;
    const stored = await m.findOneBy(RefreshToken, {
      tokenHash: hashToken(refreshToken),
      revokedAt: IsNull(),
    });
    if (!stored || stored.expiresAt < new Date()) {
      throw new BusinessException(
        HttpStatus.UNAUTHORIZED,
        'INVALID_REFRESH_TOKEN',
        'Session expirée',
      );
    }
    const user = await m.findOneBy(User, { id: stored.userId });
    if (!user?.isActive) throw invalidCredentials();
    await m.update(RefreshToken, { id: stored.id }, { revokedAt: new Date() });
    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.manager.update(
      RefreshToken,
      { tokenHash: hashToken(refreshToken), revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
  }

  async me(user: AuthUser) {
    const m = this.db.manager;
    const subscription = await this.subscriptions.summary(user.tenantId);
    return {
      user: await m.findOneByOrFail(User, { id: user.id }),
      tenant: await m.findOneByOrFail(Tenant, { id: user.tenantId }),
      // Réglages en vigueur : limités par les avantages de la formule.
      settings: effectiveSettings(
        await m.findOneByOrFail(TenantSettings, { tenantId: user.tenantId }),
        subscription.features,
      ),
      /** Formule, essai et fonctionnalités ouvertes : le web et le mobile s'y adaptent. */
      subscription,
      /** Agent : durée de travail attendue par jour (objectif affiché dans l'app) */
      ...(user.role === Role.Agent
        ? { workday: (await this.access.workdays([user.id])).get(user.id) }
        : {}),
    };
  }

  /**
   * Nouveau mot de passe : toutes les sessions sont coupées, puis de nouveaux jetons
   * sont remis à l'appareil qui a fait le changement (il reste connecté).
   */
  async changePassword(
    user: AuthUser,
    dto: ChangePasswordDto,
  ): Promise<TokensDto> {
    const m = this.db.manager;
    const current = await this.checkPassword(user, dto.currentPassword);
    await m.update(
      User,
      { id: user.id },
      { passwordHash: await hashPassword(dto.newPassword) },
    );
    await m.update(
      RefreshToken,
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    await this.revocation.revoke(user.id);
    return this.issueTokens(current);
  }

  /**
   * Prénom, nom, email : modifiables par chacun pour lui-même. Le numéro de téléphone,
   * identifiant de connexion, reste géré par l'administrateur de la structure.
   */
  async updateProfile(user: AuthUser, dto: UpdateProfileDto) {
    const m = this.db.manager;
    const current = await m.findOneByOrFail(User, { id: user.id });
    const email = dto.email?.toLowerCase();
    if (email && email !== current.email) await this.assertEmailFree(email);
    await m.update(
      User,
      { id: user.id },
      {
        ...(dto.firstName ? { firstName: dto.firstName.trim() } : {}),
        ...(dto.lastName ? { lastName: dto.lastName.trim() } : {}),
        ...(email ? { email } : {}),
      },
    );
    return this.me(user);
  }

  /** Photo de profil : PNG, JPEG ou WebP, 1 Mo maximum. */
  async setAvatar(user: AuthUser, file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length)
      throw badRequest(
        'AVATAR_REQUIRED',
        'Envoyez une image dans le champ « file »',
      );
    if (file.size > MAX_AVATAR_BYTES)
      throw badRequest(
        'AVATAR_TOO_LARGE',
        'La photo ne doit pas dépasser 1 Mo',
      );
    const mime = imageMime(file.buffer);
    if (!mime)
      throw badRequest('AVATAR_FORMAT', 'Formats acceptés : PNG, JPEG ou WebP');
    await this.db.manager.query(
      `UPDATE users SET avatar = $2, avatar_mime = $3,
              avatar_version = coalesce(avatar_version, 0) + 1
       WHERE id = $1`,
      [user.id, file.buffer, mime],
    );
    return this.me(user);
  }

  async deleteAvatar(user: AuthUser) {
    await this.db.manager.query(
      `UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_version = NULL WHERE id = $1`,
      [user.id],
    );
    return this.me(user);
  }

  private async checkPassword(user: AuthUser, password: string): Promise<User> {
    const current = await this.db.manager
      .createQueryBuilder(User, 'u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id: user.id })
      .getOneOrFail();
    if (!(await bcrypt.compare(password, current.passwordHash))) {
      throw invalidCredentials();
    }
    return current;
  }

  /** Le numéro sert d'identifiant de connexion : unique sur toute la plateforme. */
  async assertPhoneFree(phone: string, exceptUserId?: string): Promise<void> {
    const taken = await this.existsAcrossTenants(
      `SELECT exists(SELECT 1 FROM users WHERE phone = $1 AND id IS DISTINCT FROM $2::uuid)`,
      [phone, exceptUserId ?? null],
    );
    if (taken)
      throw conflict('PHONE_TAKEN', 'Ce numéro de téléphone est déjà utilisé');
  }

  async assertEmailFree(email: string): Promise<void> {
    const taken = await this.existsAcrossTenants(
      `SELECT exists(SELECT 1 FROM users WHERE lower(email) = lower($1))`,
      [email],
    );
    if (taken) throw conflict('EMAIL_TAKEN', 'Cet email est déjà utilisé');
  }

  /**
   * Email et téléphone sont des identifiants de connexion, uniques sur toute la plateforme :
   * la vérification se fait hors du périmètre de la structure (la RLS masquerait les autres).
   */
  private async existsAcrossTenants(
    sql: string,
    params: unknown[],
  ): Promise<boolean> {
    const [{ exists }] = await this.db.runAsSystem(() =>
      this.db.manager.query<{ exists: boolean }[]>(sql, params),
    );
    return exists;
  }

  private async issueTokens(user: User): Promise<TokensDto> {
    const expiresIn = this.accessTokenSeconds();
    const payload: JwtPayload = {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      email: user.email,
      iam: Date.now(),
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn });
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.manager.insert(RefreshToken, {
      tenantId: user.tenantId,
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 3600 * 1000),
    });
    return { accessToken, refreshToken, expiresIn };
  }

  private accessTokenSeconds(): number {
    const raw = this.config.get<string>('JWT_EXPIRES_IN') ?? '15m';
    const match = /^(\d+)([smhd])?$/.exec(raw);
    if (!match) return 900;
    const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2] ?? 's']!;
    return Number(match[1]) * unit;
  }
}
