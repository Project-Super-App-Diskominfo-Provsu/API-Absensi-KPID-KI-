import type { Db } from './client.js';

export class PostgisUnavailableError extends Error {
  readonly code = 'POSTGIS_NOT_AVAILABLE';

  constructor(public readonly migration: string) {
    super(
      'PostGIS is not available on the PostgreSQL server. Use Dockerfile.postgres or a matching PostGIS-enabled image for the database service. The PostgreSQL major version must match existing data. Retry migration after the database server provides the PostGIS extension.',
    );
    this.name = 'PostgisUnavailableError';
  }
}

export async function requirePostgis(db: Db, migration: string): Promise<void> {
  const available = await db.query("SELECT 1 FROM pg_available_extensions WHERE name='postgis'");
  if (!available.rowCount) throw new PostgisUnavailableError(migration);
}
