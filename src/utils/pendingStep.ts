// A document list that only says "Pending" tells nobody whose turn it is. These
// fragments attach the first unfinished approval step to a list query, so the UI can
// name the role that is holding the document up and highlight the rows the viewer
// is expected to act on.
//
// The Payment step is skipped: cash disbursement follows the chain rather than
// forming part of it, and a fully approved PayReq awaiting payment should not read
// as "waiting for approval".

export type DocType = 'PR' | 'PO' | 'PayReq' | 'Reimbursement';

/** Columns to append to a SELECT list. Pairs with {@link pendingStepJoin}. */
export const PENDING_STEP_COLUMNS = `
         nda.step_order  AS pending_step_order,
         nda.step_label  AS pending_step_label,
         nr.role_name    AS pending_role_name,
         nr.role_code    AS pending_role_code`;

/**
 * Joins that resolve the earliest still-pending step.
 *
 * `docType` and `alias` are compile-time literals from this codebase, never request
 * input — the document id is the only value that varies, and it is joined on rather
 * than interpolated.
 */
export function pendingStepJoin(docType: DocType, alias: string): string {
  return `
  LEFT JOIN (
    SELECT da.document_id, MIN(da.step_order) AS step_order
    FROM document_approvals da
    WHERE da.document_type = '${docType}'
      AND da.status = 'Pending'
      AND COALESCE(da.step_label, '') <> 'Payment'
    GROUP BY da.document_id
  ) nx ON nx.document_id = ${alias}.id
  LEFT JOIN document_approvals nda
         ON nda.document_type = '${docType}'
        AND nda.document_id = ${alias}.id
        AND nda.step_order = nx.step_order
  LEFT JOIN roles nr ON nr.id = nda.role_id`;
}
