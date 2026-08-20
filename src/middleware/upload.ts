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

// Bank statement uploads are a different kind of file: a spreadsheet, read once
// into memory and matched, then written to disk only if the import goes ahead.
// Keeping it out of the shared `upload` instance means a statement can never be
// attached to a document as if it were a proof, and a photo can never be handed to
// the parser.
//
// The mime types below are what a browser sends for .xlsx and .csv; Windows and
// some Office installs send the generic octet-stream, so the extension is trusted
// as a fallback and the parser rejects anything that is not really a workbook.
const STATEMENT_MIME = /^(application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|application\/vnd\.ms-excel|text\/csv|application\/csv|application\/octet-stream)$/;
const STATEMENT_EXT = /\.(xlsx|xlsm|csv)$/i;

export const uploadStatement = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB — a year of statement lines is far less
  fileFilter: (_req, file, cb) => {
    cb(null, STATEMENT_MIME.test(file.mimetype) && STATEMENT_EXT.test(file.originalname));
  },
});

/** Where the uploaded statement files are kept for audit. */
export const STATEMENT_PATH = process.env.STATEMENT_PATH || './storage/statements';

// Convert uploaded multer file → public-relative path string stored in DB.
export function fileToPath(file?: Express.Multer.File): string | null {
  if (!file) return null;
  const base = process.env.PUBLIC_UPLOAD_BASE || '/storage/proofs';
  return `${base}/${file.filename}`.replace(/\\/g, '/');
}
