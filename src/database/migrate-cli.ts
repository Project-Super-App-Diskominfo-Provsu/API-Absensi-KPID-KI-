import { createPool } from './client.js';
import { readDatabaseConfig } from '../config/env.js';
import { migrateDatabase } from './migrate.js';

const config = readDatabaseConfig();
const pool = createPool(config.DATABASE_URL, 1);
try {
  for (const name of await migrateDatabase(pool)) console.log(`Applied ${name}`);
} finally {
  await pool.end();
}
