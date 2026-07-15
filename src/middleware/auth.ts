import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import pool from '../db/connection';

// -----------------------------------------------------------------------------
// Password hashing — Laravel-compatible ($2y$ prefix).
// -----------------------------------------------------------------------------
export async function hashPassword(plain: string): Promise<string> {
  const hash = await bcrypt.hash(plain, 12);
  return hash.replace(/^\$2[abxy]\$/, '$2y$');
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

// -----------------------------------------------------------------------------
// JWT auth. Subject kinds: staff `User`, plus `Kth` / `Farmers` for mobile apps.
// A `jti` row in personal_access_tokens allows server-side revocation (logout).
// -----------------------------------------------------------------------------
export type UserKind = 'User' | 'Kth' | 'Farmers';

export interface AuthUser {
  id: number;
  type: UserKind;
  role?: string | null;
  roleId?: number | null;
  entityId?: number | null;
  data: any;
}

export interface AuthTokenPayload {
  sub: number;
  type: UserKind;
  jti: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      jti?: string;
    }
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const TABLE_BY_KIND: Record<UserKind, string> = {
  User: 'users',
  Kth: 'kth',
  Farmers: 'farmers',
};

export async function issueToken(kind: UserKind, id: number, name: string): Promise<string> {
  const jti = crypto.randomBytes(24).toString('hex');
  const payload: AuthTokenPayload = { sub: id, type: kind, jti };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN } as jwt.SignOptions);

  // Decode exp for the revocation record.
  const decoded = jwt.decode(token) as any;
  const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : null;
  await pool.query(
    `INSERT INTO personal_access_tokens (tokenable_type, tokenable_id, name, jti, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [kind, id, name, jti, expiresAt]
  );
  return token;
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token not provided.' });
  }
  const token = header.slice('Bearer '.length).trim();

  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET) as unknown as AuthTokenPayload;
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }

  try {
    // Revocation check (row deleted on logout).
    const [tok] = await pool.query(
      'SELECT id FROM personal_access_tokens WHERE jti = ? LIMIT 1',
      [payload.jti]
    );
    if (!(tok as any[]).length) {
      return res.status(401).json({ message: 'Token revoked.' });
    }

    const table = TABLE_BY_KIND[payload.type];
    if (!table) return res.status(401).json({ message: 'Unknown user type.' });

    const [rows] = await pool.query(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [payload.sub]);
    const list = rows as any[];
    if (!list.length) return res.status(401).json({ message: 'User not found.' });

    const u = list[0];
    delete u.password;

    let role: string | null = null;
    if (payload.type === 'User') {
      const [r] = await pool.query('SELECT role_name FROM roles WHERE id = ? LIMIT 1', [u.role_id]);
      role = (r as any[])[0]?.role_name ?? null;
    }

    req.jti = payload.jti;
    req.user = {
      id: u.id,
      type: payload.type,
      role,
      roleId: u.role_id ?? null,
      entityId: u.entity_id ?? null,
      data: u,
    };

    pool.query('UPDATE personal_access_tokens SET last_used_at = NOW() WHERE jti = ?', [payload.jti])
      .catch(() => undefined);

    next();
  } catch (err: any) {
    return res.status(500).json({ message: 'Auth error.', error: err.message });
  }
}

// Restrict to staff users only.
export function requireUser(req: Request, res: Response, next: NextFunction) {
  if (!req.user || req.user.type !== 'User') {
    return res.status(403).json({ message: 'Staff access only.' });
  }
  next();
}

// Restrict to specific roles (staff).
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || req.user.type !== 'User') {
      return res.status(403).json({ message: 'Staff access only.' });
    }
    if (roles.length && (!req.user.role || !roles.includes(req.user.role))) {
      return res.status(403).json({ message: `Requires role: ${roles.join(', ')}` });
    }
    next();
  };
}
