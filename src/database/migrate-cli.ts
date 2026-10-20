import { createPool } from './client.js';
import { migrateDatabase } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const pool = createPool(url);
try {
  for (const name of await migrateDatabase(pool)) console.log(`Applied ${name}`);
} finally {
  await pool.end();
}
