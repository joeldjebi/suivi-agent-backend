import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  totp,
  verifyTotp,
} from './totp';

describe('TOTP (RFC 6238)', () => {
  // Secret de l'annexe B de la RFC : « 12345678901234567890 » en ASCII.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('donne les codes de référence de la RFC (6 derniers chiffres)', () => {
    expect(totp(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totp(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totp(secret, Math.floor(1234567890 / 30))).toBe('005924');
    expect(totp(secret, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('accepte une période de décalage, pas plus', () => {
    const time = 1_700_000_000_000;
    const step = Math.floor(time / 30000);
    expect(verifyTotp(secret, totp(secret, step), time)).toBe(step);
    expect(verifyTotp(secret, totp(secret, step - 1), time)).toBe(step - 1);
    expect(verifyTotp(secret, totp(secret, step - 2), time)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', time)).toBeNull();
  });

  it('encode et chiffre sans perte', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    const sealed = encryptSecret(secret, 'clé');
    expect(sealed).not.toContain(secret);
    expect(decryptSecret(sealed, 'clé')).toBe(secret);
    expect(() => decryptSecret(sealed, 'autre clé')).toThrow();
  });
});
