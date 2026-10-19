import sharp from 'sharp';
import { badRequest } from './business.exception';

/** Formats d'image acceptés (logo, photo de profil), reconnus à leur signature. */
const SIGNATURES: { mime: string; test: (b: Buffer) => boolean }[] = [
  {
    mime: 'image/png',
    test: (b) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    mime: 'image/jpeg',
    test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mime: 'image/webp',
    test: (b) =>
      b.subarray(0, 4).toString() === 'RIFF' &&
      b.subarray(8, 12).toString() === 'WEBP',
  },
];

/** Type MIME de l'image, ou null si ce n'est ni du PNG, ni du JPEG, ni du WebP. */
export function imageMime(buffer: Buffer): string | null {
  return SIGNATURES.find((s) => s.test(buffer))?.mime ?? null;
}

/** Au-delà (≈ 40 mégapixels), l'image est refusée : piège à mémoire. */
const MAX_PIXELS = 40_000_000;

/**
 * Image réencodée avant d'être gardée : métadonnées retirées (position GPS, modèle du
 * téléphone, aperçus cachés), orientation appliquée, et fichiers piégés neutralisés. La
 * position d'une photo de visite reste celle relevée par l'app, enregistrée à part.
 */
export async function cleanImage(
  buffer: Buffer,
  mime: string,
): Promise<Buffer> {
  try {
    const image = sharp(buffer, {
      failOn: 'error',
      limitInputPixels: MAX_PIXELS,
    }).rotate();
    switch (mime) {
      case 'image/png':
        return await image.png({ compressionLevel: 9 }).toBuffer();
      case 'image/webp':
        return await image.webp({ quality: 85 }).toBuffer();
      default:
        return await image.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
    }
  } catch {
    throw badRequest(
      'IMAGE_INVALID',
      'Image illisible : reprenez la photo ou choisissez un autre fichier',
    );
  }
}
