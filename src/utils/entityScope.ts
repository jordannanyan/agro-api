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
    // Cross-entity roles (Procurement, Finance, Director) sit at WLI or have no
    // entity at all, yet they work across every operational PT. Pinning them to
    // their own entity_id would scope them to an org unit that owns no data.
    if (!u.roleCrossEntity && u.entityId != null) return u.entityId;
  }
  const q = req.query.entity_id;
  return q != null && q !== '' ? Number(q) : null;
}

/**
 * Decide which entity a newly created document belongs to.
 *
 * Entity-bound staff (Field Admin, Project Manager) never choose: the entity comes
 * from their account, and asking them would also let them file a document against
 * another PT. Cross-entity staff must state it, because they genuinely serve both.
 *
 * Returns either the resolved id or a message to send back as 422.
 */
export function resolveWriteEntity(
  req: Request,
  requested: unknown,
): { entityId: number } | { error: string } {
  const u = req.user as any;
  const asked = requested != null && requested !== '' ? Number(requested) : null;

  if (u?.type === 'User' && !u.roleCrossEntity && u.entityId != null) {
    if (asked != null && asked !== u.entityId) {
      return { error: 'You may only create documents for your own entity.' };
    }
    return { entityId: u.entityId };
  }

  if (asked == null) return { error: 'entity_id is required' };
  return { entityId: asked };
}
