import type { Db } from './client.js';
export async function audit(
  db: Db,
  actor: string,
  action: string,
  target: string,
  detail: unknown = {},
) {
  await db.query('INSERT INTO audit_logs(actor_id,action,target_id,detail) VALUES ($1,$2,$3,$4)', [
    actor,
    action,
    target,
    JSON.stringify(detail),
  ]);
}
