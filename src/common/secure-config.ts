/**
 * Garde-fous de configuration au démarrage. En production, l'API refuse de démarrer
 * si un réglage de sécurité est absent ou laissé à une valeur d'exemple : mieux vaut
 * un échec visible au lancement qu'une faille silencieuse en ligne.
 *
 * Hors production (développement, tests), tout est permissif pour ne pas gêner.
 */

/** Valeurs d'exemple connues : jamais acceptées comme secret en production. */
const WEAK_SECRETS = new Set([
  'change-me',
  'changeme',
  'change-me-in-production',
  'secret',
  'password',
  'test',
]);

const MIN_SECRET_LENGTH = 16;

function checkSecret(
  errors: string[],
  name: string,
  value: string | undefined,
) {
  if (!value || value.trim() === '') {
    errors.push(`${name} est obligatoire en production.`);
    return;
  }
  if (WEAK_SECRETS.has(value.trim().toLowerCase())) {
    errors.push(`${name} ne doit pas rester une valeur d'exemple.`);
    return;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    errors.push(
      `${name} est trop court (au moins ${MIN_SECRET_LENGTH} caractères).`,
    );
  }
}

/**
 * Renvoie la liste des problèmes de configuration (vide si tout va bien).
 * Pure et sans effet de bord : testable directement.
 */
export function secureConfigErrors(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const errors: string[] = [];

  // CORS : en production, une liste d'origines explicite (sinon l'API accepterait n'importe quel site).
  if (!env.CORS_ORIGIN || env.CORS_ORIGIN.trim() === '')
    errors.push('CORS_ORIGIN est obligatoire en production.');

  // Secret des structures, et secret distinct de la console éditeur (pas de dérivation en production).
  checkSecret(errors, 'JWT_SECRET', env.JWT_SECRET);
  checkSecret(errors, 'PLATFORM_JWT_SECRET', env.PLATFORM_JWT_SECRET);

  return errors;
}

/** Lève une erreur claire si la configuration de production n'est pas sûre. */
export function assertSecureConfig(env: NodeJS.ProcessEnv = process.env): void {
  const errors = secureConfigErrors(env);
  if (errors.length > 0)
    throw new Error(
      `Configuration de production incomplète :\n- ${errors.join('\n- ')}`,
    );
}
