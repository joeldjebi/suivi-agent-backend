/** Types d'événements de sécurité affichés à l'éditeur (« attaques » sur la plateforme). */
export const SecurityEventType = {
  LoginFailed: 'login_failed',
  LoginLocked: 'login_locked',
  RateLimited: 'rate_limited',
  CaptchaFailed: 'captcha_failed',
  Honeypot: 'honeypot',
} as const
export type SecurityEventType =
  (typeof SecurityEventType)[keyof typeof SecurityEventType]

export const SECURITY_EVENT_TYPE_LABELS: Record<SecurityEventType, string> = {
  login_failed: 'Mot de passe refusé',
  login_locked: 'Compte verrouillé',
  rate_limited: 'Trop de requêtes',
  captcha_failed: 'Échec du CAPTCHA',
  honeypot: 'Robot (piège)',
}

/** Courte explication de chaque type, pour l'info-bulle de la console. */
export const SECURITY_EVENT_TYPE_HINTS: Record<SecurityEventType, string> = {
  login_failed: 'Une tentative de connexion avec un mauvais mot de passe.',
  login_locked:
    'Trop d’échecs : la connexion a été bloquée un moment (compte ou adresse IP).',
  rate_limited: 'Une adresse a dépassé le plafond de requêtes autorisé.',
  captcha_failed: 'La vérification anti-robot a échoué (jeton absent ou invalide).',
  honeypot: 'Le piège du formulaire de démo a été déclenché (robot).',
}
