#!/bin/sh
# Démarrage de pgAdmin : connexion à la base PerformX préremplie (lue au premier lancement),
# puis le démarrage normal de l'image.
set -eu
printf '{"Servers":{"1":{"Name":"PerformX","Group":"Serveurs","Host":"db","Port":5432,"MaintenanceDB":"%s","Username":"%s","SSLMode":"prefer"}}}' \
  "$PGADMIN_DB_NAME" "$PGADMIN_DB_USER" > /tmp/servers.json
exec /entrypoint.sh
