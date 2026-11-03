// Pagination limits shared by every list endpoint (relaunch item 8).
// Deep OFFSET pages are refused (page > MAX_PAGE -> 400), and totals are
// counted only up to COUNT_CAP so a count never scans the whole table; the
// response says when the total was capped. Keyset pagination waits for the
// redesign, which will rework these endpoints anyway.
export const MAX_PAGE = 500;
export const COUNT_CAP = 10_000;

/** Page number from ?page=, or null when it is past MAX_PAGE. */
export function parsePage(raw, max = MAX_PAGE) {
  const page = Math.max(1, parseInt(raw, 10) || 1);
  return page > max ? null : page;
}

export const PAGE_TOO_DEEP = { error: 'page too deep; narrow the search or filter instead' };

/**
 * Count rows of `fromWhereSql` (e.g. "FROM tracks t WHERE ...") up to
 * COUNT_CAP + 1. Returns { total, total_capped }.
 */
export async function cappedCount(query, fromWhereSql, params = [], cap = COUNT_CAP) {
  const [{ n }] = await query(`SELECT COUNT(*) AS n FROM (SELECT 1 ${fromWhereSql} LIMIT ${cap + 1}) x`, params);
  const total = Number(n) || 0;
  return total > cap ? { total: cap, total_capped: true } : { total, total_capped: false };
}
