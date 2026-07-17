import { Request } from 'express';

// Resolve which entity's data the caller may see.
//  - Entities (non-superadmin) → locked to their own id.
//  - Entities (superadmin)     → ?entity_id if given, else all (null).
//  - staff User with entity_id → that entity (Finance/Director w/o entity = all).
//  - others                    → ?entity_id if given, else all.
export function entityScope(req: Request): number | null {
  const u = req.user as any;
  if (!u) return null;
  if (u.type === 'Entities') {
    if (u.data?.is_superadmin) {
      const q = req.query.entity_id;
      return q != null && q !== '' ? Number(q) : null;
    }
    return u.id;
  }
  if (u.type === 'User') {
    if (u.entityId != null) return u.entityId;
  }
  const q = req.query.entity_id;
  return q != null && q !== '' ? Number(q) : null;
}
