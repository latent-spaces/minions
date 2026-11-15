import sharp from 'sharp';
import { PROGRESS_LIMITS } from '@minions/contracts';
import { Refusal } from '../errors.js';
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
function inputError(message: string): never { throw new Refusal('bad_input', message); }
export async function normalizeStillImage(bytes: Buffer, mime: string) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PROGRESS_LIMITS.uploadBytes || !Object.values(MIME).includes(mime as typeof MIME[keyof typeof MIME]))
    inputError('Use a PNG, JPEG or WebP image up to 2 MiB.');
  try {
    const image = sharp(bytes, { failOn: 'warning', limitInputPixels: PROGRESS_LIMITS.imagePixels, animated: true });
    const metadata = await image.metadata();
    const format = metadata.format as keyof typeof MIME;
    if (!MIME[format] || MIME[format] !== mime || (metadata.pages ?? 1) !== 1 || !metadata.width || !metadata.height
      || metadata.width > PROGRESS_LIMITS.imageSide || metadata.height > PROGRESS_LIMITS.imageSide
      || metadata.width * metadata.height > PROGRESS_LIMITS.imagePixels) inputError('Use a still image with matching file type, at most 4096 pixels per side and 16 million pixels.');
    // Store only optimized pixels, never the original metadata-bearing upload.
    const optimized = image.rotate().resize({ width: PROGRESS_LIMITS.displayImageSide,
      height: PROGRESS_LIMITS.displayImageSide, fit: 'inside', withoutEnlargement: true });
    let encoded = await optimized.clone().webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (encoded.data.length > PROGRESS_LIMITS.storedImageBytes)
      encoded = await optimized.webp({ quality: 65, effort: 4 }).toBuffer({ resolveWithObject: true });
    if (encoded.data.length > PROGRESS_LIMITS.storedImageBytes) inputError('This image is still over 2 MiB after compressing. Make it smaller, then upload it with a new upload ID.');
    return { bytes: encoded.data, media: { mimeType: MIME.webp, byteSize: encoded.data.length, width: encoded.info.width, height: encoded.info.height } };
  } catch (error) {
    if (error instanceof Refusal) throw error;
    inputError('The image could not be decoded. Use a valid still PNG, JPEG or WebP image.');
  }
}
