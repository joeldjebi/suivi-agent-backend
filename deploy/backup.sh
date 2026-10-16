#!/bin/sh
# Sauvegarde automatique de la base : une copie complète chaque nuit (format pg_dump
# compressé), vérifiée, gardée BACKUP_KEEP_DAYS jours. Tourne dans le service « backup ».
#
# Variables : PGHOST, PGUSER, PGPASSWORD, PGDATABASE (connexion), BACKUP_HOUR (heure UTC,
# 2 par défaut), BACKUP_KEEP_DAYS (14 par défaut). Les copies vont dans /backups.
set -eu

HOUR="${BACKUP_HOUR:-2}"
KEEP="${BACKUP_KEEP_DAYS:-14}"
DIR=/backups

log() { echo "[sauvegarde] $(date -u '+%F %T') $*"; }

backup() {
  name="suivi-agent_$(date -u '+%F_%H%M').dump"
  tmp="$DIR/.$name.part"
  if pg_dump --format=custom --compress=6 --file="$tmp" \
     && pg_restore --list "$tmp" > /dev/null; then
    mv "$tmp" "$DIR/$name"
    log "OK $name ($(du -h "$DIR/$name" | cut -f1))"
    # Rotation : seulement si la copie du jour a réussi.
    find "$DIR" -maxdepth 1 -name 'suivi-agent_*.dump' -mtime +"$KEEP" -print -delete \
      | sed 's/^/[sauvegarde] supprimée (ancienne) : /'
  else
    rm -f "$tmp"
    log "ÉCHEC : la copie de la base n'a pas pu être faite"
  fi
}

mkdir -p "$DIR"
until pg_isready -q; do sleep 5; done

# Au démarrage : une copie tout de suite s'il n'y en a pas encore aujourd'hui.
ls "$DIR"/suivi-agent_"$(date -u '+%F')"_*.dump > /dev/null 2>&1 || backup

while true; do
  now=$(date -u '+%s')
  next=$(date -u -d "$(date -u '+%F') $HOUR:00:00" '+%s')
  [ "$next" -le "$now" ] && next=$((next + 86400))
  log "prochaine copie dans $(( (next - now) / 60 )) min"
  sleep $((next - now))
  backup
done
