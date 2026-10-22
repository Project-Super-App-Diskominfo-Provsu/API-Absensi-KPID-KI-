import type { Db } from './client.js';

export async function queryPage<T>(
  db: Db,
  sql: string,
  values: unknown[],
  orderBy: string,
  limit: number,
  offset: number,
) {
  // SQL and ordering are internal constants; request values use bound parameters.
  const result = await db.query<{ data: T[]; total: number }>(
    `WITH filtered AS (${sql}), page AS (SELECT * FROM filtered ORDER BY ${orderBy} LIMIT $${values.length + 1} OFFSET $${values.length + 2})
    SELECT (SELECT count(*)::int FROM filtered) AS total,
    COALESCE((SELECT json_agg(page ORDER BY ${orderBy}) FROM page),'[]'::json) AS data`,
    [...values, limit, offset],
  );
  return { ...result.rows[0]!, meta: { limit, offset, total: result.rows[0]!.total } };
}
