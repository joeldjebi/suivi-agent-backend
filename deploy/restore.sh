#!/bin/sh
# Restauration de la base depuis une copie de /opt/suivi-agent/backups.
# À lancer depuis le dossier deploy/ :  sh restore.sh suivi-agent_2026-10-16_0200.dump
#
# L'API est arrêtée pendant la restauration, puis redémarrée (les migrations repassent).
set -eu

FILE="${1:-}"
DIR="${BACKUP_DIR:-../../backups}"
COMPOSE="docker compose -f docker-compose.prod.yml"

if [ -z "$FILE" ] || [ ! -f "$DIR/$FILE" ]; then
  echo "Usage : sh restore.sh <fichier>   (copies disponibles ci-dessous)"
  ls -lh "$DIR" 2>/dev/null | grep 'suivi-agent_' || echo "  aucune copie dans $DIR"
  exit 1
fi

printf "La base actuelle sera REMPLACÉE par %s. Taper OUI pour continuer : " "$FILE"
read -r answer
[ "$answer" = "OUI" ] || { echo "Annulé."; exit 1; }

$COMPOSE stop api
$COMPOSE exec -T backup sh -c \
  "pg_restore --clean --if-exists --no-owner --exit-on-error -d \"\$PGDATABASE\" /backups/$FILE"
$COMPOSE start api
echo "Restauration terminée. Vérifier : curl http://localhost:\${PUBLIC_PORT:-8090}/api/health"
