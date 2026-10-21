#!/bin/bash
set -e

# Automatically enable PostGIS when initializing a new PostgreSQL database container
echo "Initializing PostGIS extensions in database: ${POSTGRES_DB:-absensi}..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-absensi}" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS postgis_topology;
EOSQL
echo "PostGIS extensions successfully enabled."
