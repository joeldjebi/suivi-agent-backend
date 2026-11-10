import { assertSecureConfig, secureConfigErrors } from './secure-config';

const ok = {
  NODE_ENV: 'production',
  CORS_ORIGIN: 'https://performx.online',
  JWT_SECRET: 'un-secret-bien-assez-long-123',
  PLATFORM_JWT_SECRET: 'autre-secret-bien-assez-long-456',
} as NodeJS.ProcessEnv;

describe('secure-config', () => {
  it('ne vérifie rien hors production', () => {
    expect(secureConfigErrors({ NODE_ENV: 'development' })).toEqual([]);
    expect(secureConfigErrors({})).toEqual([]);
  });

  it('accepte une configuration de production complète', () => {
    expect(secureConfigErrors(ok)).toEqual([]);
    expect(() => assertSecureConfig(ok)).not.toThrow();
  });

  it('exige CORS_ORIGIN en production', () => {
    expect(secureConfigErrors({ ...ok, CORS_ORIGIN: '' })).toContain(
      'CORS_ORIGIN est obligatoire en production.',
    );
  });

  it('exige les deux secrets en production', () => {
    expect(secureConfigErrors({ ...ok, JWT_SECRET: undefined })).toContain(
      'JWT_SECRET est obligatoire en production.',
    );
    expect(
      secureConfigErrors({ ...ok, PLATFORM_JWT_SECRET: undefined }),
    ).toContain('PLATFORM_JWT_SECRET est obligatoire en production.');
  });

  it('refuse une valeur d’exemple', () => {
    expect(secureConfigErrors({ ...ok, JWT_SECRET: 'change-me' })).toContain(
      "JWT_SECRET ne doit pas rester une valeur d'exemple.",
    );
  });

  it('refuse un secret trop court', () => {
    const errors = secureConfigErrors({ ...ok, JWT_SECRET: 'court' });
    expect(errors.some((e) => e.includes('trop court'))).toBe(true);
  });

  it('assertSecureConfig lève avec le détail des problèmes', () => {
    expect(() => assertSecureConfig({ NODE_ENV: 'production' })).toThrow(
      /Configuration de production incomplète/,
    );
  });
});
