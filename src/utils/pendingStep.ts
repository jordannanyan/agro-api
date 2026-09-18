// A document list that only says "Pending" tells nobody whose turn it is. These
// fragments attach the first unfinished approval step to a list query, so the UI can
// name the role that is holding the document up and highlight the rows the viewer
// is expected to act on.
//
// The Payment step is skipped: cash disbursement follows the chain rather than
// forming part of it, and a fully approved PayReq awaiting payment should not read
// as "waiting for approval".

export type DocType = 'PR' | 'PO' | 'PayReq' | 'Reimbursement' | 'Expense';

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
export function pendingStepJoin(docType: DocType | DocType[], alias: string): string {
  // A LIST of types, not one, for `payment_requests`: it holds three kinds of
  // document under three different `document_type` values, and the Payment Request
  // list shows a procurement request and an expense claim side by side. A fixed
  // 'PayReq' would silently show every expense claim as having nobody waiting on it.
  //
  // Matched with a constant IN-list rather than a CASE over the outer row. A CASE
  // here reads correctly and is not: MySQL gives the derived table an auto-generated
  // key and the results came back inconsistent — the same row matched when queried
  // alone and did not when queried alongside others. The id is unique within
  // payment_requests anyway, so the list is only there to keep a PR or PO of the
  // same id out.
  const types = Array.isArray(docType) ? docType : [docType];
  const t = types.map((x) => `'${x}'`).join(', ');
  return `
  LEFT JOIN (
    SELECT da.document_id, da.document_type, MIN(da.step_order) AS step_order
    FROM document_approvals da
    WHERE da.status = 'Pending'
      AND COALESCE(da.step_label, '') <> 'Payment'
    GROUP BY da.document_id, da.document_type
  ) nx ON nx.document_id = ${alias}.id AND nx.document_type IN (${t})
  LEFT JOIN document_approvals nda
         ON nda.document_type IN (${t})
        AND nda.document_id = ${alias}.id
        AND nda.step_order = nx.step_order
  LEFT JOIN roles nr ON nr.id = nda.role_id`;
}

/**
 * Every `document_type` a `payment_requests` row can keep its approvals under.
 *
 * Three kinds share that table and each has its own chain. A row only ever has one
 * of them, so matching the whole list is exact — and it keeps a purchase request of
 * the same id from being read as this document's chain.
 */
export const PAYREQ_DOC_TYPES: DocType[] = ['PayReq', 'Reimbursement', 'Expense'];
