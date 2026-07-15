import sharp from 'sharp';
import fs from 'fs';

// Compress an image in place (best-effort). Skips PDFs / missing files.
export async function compressImage(filePath?: string | null): Promise<void> {
  if (!filePath || !fs.existsSync(filePath)) return;
  if (/\.pdf$/i.test(filePath)) return;
  try {
    const buf = await sharp(filePath).rotate().resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 78 }).toBuffer();
    fs.writeFileSync(filePath, buf);
  } catch {
    // non-fatal: leave original
  }
}

export async function compressImages(paths: (string | null | undefined)[]): Promise<void> {
  await Promise.all(paths.map(compressImage));
}
