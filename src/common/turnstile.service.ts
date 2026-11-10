import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BusinessException } from './business.exception';

/** Point de vérification des jetons Turnstile (CAPTCHA de Cloudflare). */
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Anti-robot Turnstile (Cloudflare). Activé uniquement si TURNSTILE_SECRET est configuré :
 * sans clé (développement, tests), la vérification ne fait rien, pour ne rien casser. La
 * clé publique correspondante (VITE_TURNSTILE_SITE_KEY) est posée côté site : sans elle, le
 * widget ne s'affiche pas et aucun jeton n'est envoyé.
 */
@Injectable()
export class TurnstileService {
  private readonly logger = new Logger(TurnstileService.name);

  constructor(private readonly config: ConfigService) {}

  /** La protection n'est active que si la clé secrète est configurée. */
  get enabled(): boolean {
    return !!this.config.get<string>('TURNSTILE_SECRET');
  }

  /**
   * Vérifie le jeton du widget auprès de Cloudflare. Désactivée sans clé secrète. Un jeton
   * absent ou explicitement invalide est refusé (403). Si Cloudflare est injoignable, on
   * laisse passer : une panne du vérificateur ne doit pas bloquer les inscriptions légitimes.
   */
  async verify(token: string | undefined, ip?: string): Promise<void> {
    const secret = this.config.get<string>('TURNSTILE_SECRET');
    if (!secret) return; // protection désactivée
    if (!token) throw this.refus();
    let ok = false;
    try {
      const form = new URLSearchParams({ secret, response: token });
      if (ip) form.set('remoteip', ip);
      const res = await fetch(VERIFY_URL, { method: 'POST', body: form });
      const data = (await res.json()) as { success?: boolean };
      ok = data.success === true;
    } catch (e) {
      this.logger.error(`Vérification Turnstile impossible : ${String(e)}`);
      return; // disponibilité : on ne bloque pas sur une panne de Cloudflare
    }
    if (!ok) throw this.refus();
  }

  private refus(): BusinessException {
    return new BusinessException(
      HttpStatus.FORBIDDEN,
      'CAPTCHA_REQUIRED',
      'Vérification anti-robot échouée. Rechargez la page et réessayez.',
    );
  }
}
