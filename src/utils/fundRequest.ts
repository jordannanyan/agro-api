import type { Pool, PoolConnection } from 'mysql2/promise';
import type { Request } from 'express';
import { ROLE, FUND_REQUEST_FINANCE_ROLES } from './roles';
import { entityScope } from './entityScope';

// -----------------------------------------------------------------------------
// Fund Request — shared rules: who may touch which part, how the figures are
// computed, and where Actual comes from. One place, because the document route,
// the Budget / Actual reports and the payment request picker all read the same
// numbers and must never disagree.
// -----------------------------------------------------------------------------

type Db = Pool | PoolConnection;

export type Stage = 'requested' | 'prepared' | 'director_approved' | 'hq_approved';
export type SectionKey = 'personnel' | 'overhead_other' | 'operational' | 'offtake' | 'finance_core';
export type Section =
  | 'bank_balance' | 'shifted' | 'new_item' | 'offtake_in' | 'offtake_out' | 'min_balance' | 'others'
  | 'trading_bank' | 'trading_shifted' | 'trading_new' | 'trading_min';

export const SECTIONS: Section[] = [
  'bank_balance', 'shifted', 'new_item', 'offtake_in', 'offtake_out', 'min_balance', 'others',
  'trading_bank', 'trading_shifted', 'trading_new', 'trading_min',
];
export const SECTION_KEYS: SectionKey[] = ['personnel', 'overhead_other', 'operational', 'offtake', 'finance_core'];

/** Lines that plan spending — the budget. Balances, cash-in and reserves are not. */
export const BUDGET_SECTIONS: Section[] = ['shifted', 'new_item', 'offtake_out', 'trading_shifted', 'trading_new'];
/** Sections that hang off a group, and which group areas they belong in. */
const GROUP_SECTIONS: Partial<Record<Section, string[]>> = {
  new_item: ['overhead', 'operational'],
  offtake_in: ['offtake'], offtake_out: ['offtake'],
  trading_bank: ['trading'], trading_shifted: ['trading'], trading_new: ['trading'], trading_min: ['trading'],
};
export const sectionNeedsGroup = (s: Section) => !!GROUP_SECTIONS[s];
export const groupAreaFits = (s: Section, area: string) => (GROUP_SECTIONS[s] || []).includes(area);

export const SECTION_LABEL: Record<SectionKey, string> = {
  personnel: 'Personnel Costs',
  overhead_other: 'Overhead lainnya',
  operational: 'Operational',
  offtake: 'Offtake (1.4) dan Section 2',
  finance_core: 'Saldo, shifted, minimum, others',
};

/** Which owner's part a line sits in. */
export function sectionKeyOf(section: Section, group: { area: string; owner_role: string } | null): SectionKey {
  if (!group) return 'finance_core';
  if (group.area === 'offtake' || group.area === 'trading') return 'offtake';
  if (group.area === 'operational') return 'operational';
  return group.owner_role === 'hr' ? 'personnel' : 'overhead_other';
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export interface FrAccess {
  read: boolean;
  finance: boolean;     // compiles the document; edits every part
  hr: boolean;          // personnel costs
  pm: boolean;          // operational, offtake, Section 2 — of their own PT
  superAdmin: boolean;
  userId: number | null;
}

export function frAccess(req: Request, entityId: number): FrAccess {
  const u = req.user;
  const userId = u?.type === 'User' ? u.id : null;
  const scope = entityScope(req);
  const read = !!u && u.type === 'User' && (scope == null || Number(scope) === Number(entityId));
  const role = u?.roleCode || '';
  return {
    read,
    finance: read && (FUND_REQUEST_FINANCE_ROLES as string[]).includes(role),
    hr: read && role === ROLE.HR,
    pm: read && role === ROLE.PROJECT_MANAGER && (!!u?.roleCrossEntity || Number(u?.entityId) === Number(entityId)),
    superAdmin: read && role === ROLE.SUPER_ADMIN,
    userId,
  };
}

/** May this caller edit a line in this part of the document? */
export function mayEditSection(a: FrAccess, key: SectionKey, sectionDone: boolean): boolean {
  if (a.superAdmin || a.finance) return true;
  if (key === 'personnel' && a.hr) return !sectionDone;
  if ((key === 'operational' || key === 'offtake') && a.pm) return true;
  return false;
}

/** May this caller mark this part done / reopen it? Its owners. */
export function mayMarkSection(a: FrAccess, key: SectionKey): boolean {
  if (a.superAdmin || a.finance) return true;
  if (key === 'personnel') return a.hr;
  if (key === 'operational' || key === 'offtake') return a.pm;
  return false;
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export interface FrRates { rate_sgd: number; rate_usd: number; rate_eur: number }

export function toIdr(amount: number, currency: string, r: FrRates): number {
  const a = Number(amount || 0);
  if (currency === 'SGD') return a * Number(r.rate_sgd || 0);
  if (currency === 'USD') return a * Number(r.rate_usd || 0);
  if (currency === 'EUR') return a * Number(r.rate_eur || 0);
  return a;
}

export interface CalcLine { id: number; section: Section; group_id: number | null; idr: number }
export interface CalcGroup { id: number; area: string; label: string }

/**
 * The document's totals, exactly as the workbook computes them.
 *   1.3 = 1.1 − 1.2 · 1.5 = 1.3 − overhead − operational + (offtake in − out)
 *   1.8 = IF(1.5 + 1.6 + 1.7 > 0, 0, −(1.5 + 1.6 + 1.7))   (1.6 is entered negative)
 *   per Section 2 block: IF(bank − shifted − new + minimum > 0, 0, −that)
 */
export function computeTotals(lines: CalcLine[], groups: CalcGroup[], rateSgd: number,
  funding: { wli: number; entity: number; feeSgd: number }) {
  const sum = (f: (l: CalcLine) => boolean) => lines.filter(f).reduce((s, l) => s + l.idr, 0);
  const area = new Map(groups.map((g) => [g.id, g.area]));
  const c1_1 = sum((l) => l.section === 'bank_balance');
  const c1_2 = sum((l) => l.section === 'shifted');
  const c1_3 = c1_1 - c1_2;
  const overhead = sum((l) => l.section === 'new_item' && area.get(l.group_id as number) === 'overhead');
  const operational = sum((l) => l.section === 'new_item' && area.get(l.group_id as number) === 'operational');
  const offtakeNet = sum((l) => l.section === 'offtake_in') - sum((l) => l.section === 'offtake_out');
  const c1_5 = c1_3 - overhead - operational + offtakeNet;
  const c1_6 = sum((l) => l.section === 'min_balance');
  const c1_7 = sum((l) => l.section === 'others');
  const raw = c1_5 + c1_6 + c1_7;
  const c1_8 = raw > 0 ? 0 : -raw;

  const trading = groups.filter((g) => g.area === 'trading').map((g) => {
    const t = (s: Section) => sum((l) => l.section === s && l.group_id === g.id);
    const bank = t('trading_bank'), shifted = t('trading_shifted'), nw = t('trading_new'), min = t('trading_min');
    const post = bank - shifted, fore = post - nw, r = fore + min;
    return { group_id: g.id, label: g.label, bank, shifted, post, new: nw, forecast: fore, min, fund_request: r > 0 ? 0 : -r };
  });
  const s2 = trading.reduce((s, t) => s + t.fund_request, 0);
  const grand = c1_8 + s2;
  const fee = Number(funding.feeSgd || 0) * Number(rateSgd || 0);
  const netWli = grand * Number(funding.wli || 0);
  const netEntity = grand * Number(funding.entity || 0);
  return {
    c1_1, c1_2, c1_3, c1_4: overhead + operational, overhead, operational, offtake_net: offtakeNet,
    c1_5, c1_6, c1_7, c1_8, trading, s2_total: s2, grand,
    funding: { net_wli: netWli, net_entity: netEntity, gross_wli: netWli - fee, gross_entity: netEntity - fee },
  };
}

/** Net approved reallocation per line: + what moved in, − what moved out. */
export async function reallocMap(db: Db, frId: number) {
  const [rows] = await db.query(
    `SELECT r.to_line_id AS line_id, r.total AS amt FROM fund_request_reallocations r
      WHERE r.fund_request_id = ? AND r.status = 'approved'
     UNION ALL
     SELECT rl.from_line_id, -rl.amount FROM fund_request_realloc_lines rl
       JOIN fund_request_reallocations r ON r.id = rl.reallocation_id
      WHERE r.fund_request_id = ? AND r.status = 'approved'`, [frId, frId]);
  const m = new Map<number, number>();
  for (const r of rows as any[]) m.set(Number(r.line_id), (m.get(Number(r.line_id)) || 0) + Number(r.amt));
  return m;
}

/** Paid payment requests per line — the transaction side of Actual. */
export async function paidByLine(db: Db, lineIds: number[]) {
  const m = new Map<number, { paid: number; count: number }>();
  if (!lineIds.length) return m;
  const [rows] = await db.query(
    `SELECT fund_request_line_id AS id, SUM(amount) AS paid, COUNT(*) AS n FROM payment_requests
      WHERE status = 'Paid' AND fund_request_line_id IN (?) GROUP BY fund_request_line_id`, [lineIds]);
  for (const r of rows as any[]) m.set(Number(r.id), { paid: Number(r.paid || 0), count: Number(r.n || 0) });
  return m;
}

/**
 * The PT's short code: "PT Java Nature Based Solutions (JNBS)" → "JNBS",
 * "SNBS Lampung" → "SNBS" (the first all-capitals word), else a sanitised name.
 */
export function entityShort(name: string | null | undefined, id: number): string {
  const n = String(name || '');
  const paren = n.match(/\(([^)]+)\)/);
  if (paren) return paren[1].replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || `E${id}`;
  const caps = n.match(/\b([A-Z]{2,8})\b/);
  if (caps && caps[1] !== 'PT') return caps[1];
  return n.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 12) || `E${id}`;
}

export function prevPeriod(p: string): string {
  const [y, m] = p.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export const STAGE_LABEL: Record<Stage, string> = {
  requested: 'Disusun', prepared: 'Menunggu Director', director_approved: 'Menunggu HQ', hq_approved: 'Disetujui',
};

/** The groups a new document starts with when there is no previous month to copy. */
export function defaultGroups(short: string) {
  type G = { area: 'overhead' | 'operational' | 'offtake' | 'trading'; label: string; owner_role: 'finance' | 'hr' | 'pm' };
  const g = (area: G['area'], label: string, owner_role: G['owner_role']): G => ({ area, label, owner_role });
  if (short === 'SNBS') {
    return [
      g('overhead', '1.0 Personnel Costs', 'hr'), g('overhead', '2.0 Other', 'finance'),
      g('overhead', '3.0 Lampung Specific', 'finance'),
      g('operational', '1.0 Own-managed Plantation', 'pm'), g('operational', '2.0 Cocoa-Fermented', 'pm'),
      g('operational', '3.0 Replenishment Cash - for Director', 'pm'), g('operational', '4.0 Socialization', 'pm'),
      g('operational', '5.0 Traceability', 'pm'),
      g('offtake', 'Cocoa offtake', 'pm'), g('offtake', 'Cavendish (banana) offtake', 'pm'),
      g('trading', '2.1 Cocoa offtake', 'pm'), g('trading', '2.2 Cocoa offtake [fermented]', 'pm'),
      g('trading', '2.3 Coffee offtake', 'pm'),
    ];
  }
  if (short === 'JNBS') {
    return [
      g('overhead', '1.0 Personnel Costs', 'hr'), g('overhead', '2.0 Other', 'finance'),
      g('overhead', '3.0 Overhead - Jogja Office & Besole mess', 'finance'),
      g('overhead', '4.0 Petty Cash - Jogja office', 'finance'), g('overhead', '5.0 Petty Cash - Besole mess', 'finance'),
      g('operational', 'Operational [Others excl. Cavendish] — 1.0 Monthly Monitoring & Evaluation, Project Area Visit', 'pm'),
      g('operational', 'Operational [Others excl. Cavendish] — 2.0 Other', 'pm'),
      g('operational', 'Operational [Existing Plantation - Banana] — 1.0 Cash out (one-offs)', 'pm'),
      g('operational', "Operational [Existing Plantation - Banana] — 2.0 Cash out, profit sharing (Mustari's land, part of loan)", 'pm'),
      g('operational', 'Operational [Existing Plantation - Banana] — 3.0 Cash out (part of loan)', 'pm'),
      g('operational', 'Operational [Existing Plantation - Banana] — 4.0 Cash out, part of loan (SAPRODI)', 'pm'),
      g('offtake', 'Banana offtake', 'pm'),
      g('trading', '2.1 Banana offtake', 'pm'),
    ];
  }
  return [
    g('overhead', '1.0 Personnel Costs', 'hr'), g('overhead', '2.0 Other', 'finance'),
    g('operational', '1.0 Operational', 'pm'),
  ];
}
