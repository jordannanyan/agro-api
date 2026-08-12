import { Request, Response, NextFunction } from 'express';
import { OPERATIONS_READ_ONLY_ROLES } from '../utils/roles';

/**
 * Make the operational modules read-only for the roles that only supervise them.
 *
 * The NBSV administrators need to see every PT's documents to support people —
 * that is why the lists are unscoped for them. Seeing is not the same as acting,
 * though: an administrator approving a payment or issuing stock would put a name
 * in the approval chain that answers to nobody in the business flow.
 *
 * Applied to the routers that carry business transactions. Deliberately NOT
 * applied to users, roles, entities or the master-data routers: maintaining those
 * *is* the administrator's job.
 *
 * GET and HEAD always pass. The check is by role, so every other account —
 * including the Super Admin break-glass — is unaffected.
 */
export function operationsReadOnly(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const role = req.user?.roleCode;
  if (req.user?.type === 'User' && role && OPERATIONS_READ_ONLY_ROLES.includes(role as any)) {
    return res.status(403).json({
      message: `Role ${role} berhak melihat seluruh data operasional, tetapi tidak mengubahnya. `
        + 'Perubahan dilakukan oleh peran yang menjalankan alurnya.',
    });
  }
  return next();
}
