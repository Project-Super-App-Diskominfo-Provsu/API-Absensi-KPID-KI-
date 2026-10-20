import { hashPassword, MIN_PASSWORD_LENGTH } from '../shared/security/password.js';
import { z } from 'zod';
import { databaseConfigSchema } from '../config/env.js';
import { createPool, transaction } from '../database/client.js';
import { audit } from '../database/audit.js';
const env = z
  .object({
    ...databaseConfigSchema.shape,
    ADMIN_EMAIL: z.email(),
    ADMIN_PASSWORD: z.string().min(MIN_PASSWORD_LENGTH).max(128),
    ADMIN_NAME: z.string().min(1),
    ADMIN_EMPLOYEE_NUMBER: z.string().min(1),
  })
  .parse(process.env);
const pool = createPool(env.DATABASE_URL, 1);
try {
  const password = await hashPassword(env.ADMIN_PASSWORD);
  await transaction(pool, async (db) => {
    const row = await db.query(
      "INSERT INTO users(employee_number,name,email,password_hash,role) VALUES($1,$2,$3,$4,'SUPER_ADMIN') RETURNING id",
      [env.ADMIN_EMPLOYEE_NUMBER, env.ADMIN_NAME, env.ADMIN_EMAIL.toLowerCase(), password],
    );
    await audit(db, row.rows[0].id, 'ADMIN_BOOTSTRAPPED', row.rows[0].id);
  });
  console.log('Admin created. Remove ADMIN_PASSWORD from the environment.');
} finally {
  await pool.end();
}
