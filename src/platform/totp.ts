import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Codes à usage unique (TOTP, RFC 6238) compatibles avec Google Authenticator, Microsoft
 * Authenticator, 1Password… : HMAC-SHA1, 6 chiffres, pas de 30 secondes.
 */
const STEP_SECONDS = 30;
const DIGITS = 6;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secret de 160 bits, en base 32 (saisie manuelle possible dans l'application). */
export const generateSecret = () => base32Encode(randomBytes(20));

export const stepAt = (time = Date.now()) =>
  Math.floor(time / 1000 / STEP_SECONDS);

export function totp(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret))
    .update(counter)
    .digest();
  const offset = hmac[hmac.length - 1] & 15;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, '0');
}

/**
 * Pas de temps du code s'il est valable (une période de tolérance de chaque côté pour
 * l'horloge du téléphone), sinon null. Comparaison à temps constant.
 */
export function verifyTotp(
  secret: string,
  code: string,
  time = Date.now(),
): number | null {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const now = stepAt(time);
  for (const step of [now, now - 1, now + 1]) {
    if (timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(digits)))
      return step;
  }
  return null;
}

export const otpauthUrl = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// --------------------------------------------------------- codes de secours

/** Huit codes « abcd-efgh » à usage unique, pour un téléphone perdu. */
export function generateRecoveryCodes(count = 8): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
    return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
  });
}

export const hashRecoveryCode = (code: string) =>
  createHash('sha256')
    .update(code.trim().toLowerCase().replace(/\s/g, ''))
    .digest('hex');

// ------------------------------------------------- chiffrement du secret

/** Le secret est chiffré en base (AES-256-GCM) : une copie de la base ne suffit pas. */
export function encryptSecret(secret: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update(key).digest(),
    iv,
  );
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data]
    .map((b) => b.toString('base64'))
    .join('.');
}

export function decryptSecret(payload: string, key: string): string {
  const [iv, tag, data] = payload
    .split('.')
    .map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(
    'aes-256-gcm',
    createHash('sha256').update(key).digest(),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  );
}
