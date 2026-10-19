import sharp from 'sharp';
import { cleanImage, imageMime } from './image';

describe('Images envoyées', () => {
  it('retire les métadonnées (position GPS) et garde le format', async () => {
    const withGps = await sharp({
      create: { width: 40, height: 30, channels: 3, background: '#2563eb' },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'Téléphone' }, IFD3: { GPSLatitudeRef: 'N' } })
      .toBuffer();
    expect((await sharp(withGps).metadata()).exif).toBeDefined();

    const clean = await cleanImage(withGps, 'image/jpeg');
    expect(imageMime(clean)).toBe('image/jpeg');
    const meta = await sharp(clean).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([40, 30]);
  });

  it('refuse un fichier qui imite une image', async () => {
    const fake = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    await expect(cleanImage(fake, 'image/png')).rejects.toMatchObject({
      response: { code: 'IMAGE_INVALID' },
    });
  });
});
