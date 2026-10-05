import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

/** Durée de conservation d'une révocation : au-delà, tout jeton d'accès émis avant a expiré. */
const REVOCATION_TTL_SECONDS = 24 * 3600;

/**
 * Coupe immédiatement l'accès d'un utilisateur (désactivation, suppression,
 * changement de rôle ou de mot de passe) : les jetons d'accès émis avant sont refusés.
 */
@Injectable()
export class SessionRevocationService {
  constructor(private readonly redis: RedisService) {}

  private key(userId: string) {
    return `revoked:${userId}`;
  }

  /** Les jetons émis jusqu'à maintenant (à la milliseconde) sont refusés. */
  async revoke(userId: string): Promise<void> {
    const now = Date.now();
    await this.redis.client.set(
      this.key(userId),
      String(now),
      'EX',
      REVOCATION_TTL_SECONDS,
    );
  }

  /**
   * Vrai si le jeton a été révoqué. `iam` (millisecondes) : refusé s'il a été émis avant
   * la révocation, un jeton remis juste après reste valable. Anciens jetons sans `iam` :
   * précision à la seconde, refusés s'ils datent de la même seconde ou d'avant.
   */
  async isRevoked(
    userId: string,
    issued: { iat?: number; iam?: number },
  ): Promise<boolean> {
    const raw = await this.redis.client.get(this.key(userId));
    if (raw === null) return false;
    // Anciennes révocations enregistrées en secondes.
    const revokedAt =
      Number(raw) < 1e12 ? Number(raw) * 1000 + 999 : Number(raw);
    if (issued.iam !== undefined) return issued.iam < revokedAt;
    return (issued.iat ?? 0) * 1000 <= revokedAt;
  }
}
