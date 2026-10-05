#!/bin/sh
# Exécuté une seule fois, à la création du volume de la base : rôle utilisé par l'API
# (ni superutilisateur ni propriétaire des tables, pour que la Row Level Security s'applique).
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE "$APP_DB_USER" LOGIN PASSWORD '$APP_DB_PASSWORD';
SQL
