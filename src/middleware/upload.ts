import multer from 'multer';
import fs from 'fs';
import path from 'path';

const UPLOAD_PATH = process.env.UPLOAD_PATH || './storage/proofs';
fs.mkdirSync(UPLOAD_PATH, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_PATH),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${Date.now()}_${base}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const ok = /^(image\/(jpeg|png|jpg|gif|svg\+xml)|application\/pdf)$/.test(file.mimetype);
    cb(null, ok);
  },
});

// Convert uploaded multer file → public-relative path string stored in DB.
export function fileToPath(file?: Express.Multer.File): string | null {
  if (!file) return null;
  const base = process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs';
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}
