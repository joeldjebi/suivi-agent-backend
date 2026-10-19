#!/bin/sh
# Branche le sous-domaine de la version web de l'app (ex. app.performx.online) sur le port
# APP_PORT (8092), sans risque pour les autres sites : configuration vérifiée avant tout
# redémarrage d'Apache, et retirée si elle échoue.
# Usage : sh cpanel/install-app.sh <utilisateur cPanel> <sous-domaine>
set -eu
USER_NAME="$1"
DOMAIN="$2"
PORT="${APP_PORT:-8092}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STD="/etc/apache2/conf.d/userdata/std/2_4/$USER_NAME/$DOMAIN"
SSL="/etc/apache2/conf.d/userdata/ssl/2_4/$USER_NAME/$DOMAIN"
mkdir -p "$STD" "$SSL"
cp "$HERE/http.conf" "$STD/performx-app.conf"
sed "s#127.0.0.1:8090#127.0.0.1:$PORT#g" "$HERE/https.conf" > "$SSL/performx-app.conf"
/scripts/ensure_vhost_includes --user="$USER_NAME"
/scripts/rebuildhttpdconf > /dev/null 2>&1 || true
if httpd -t; then
  /scripts/restartsrv_httpd
  echo "OK : https://$DOMAIN est branché sur la version web de PerformX."
else
  echo "ERREUR : configuration refusée, retrait des fichiers (Apache n'a pas été redémarré)."
  rm -f "$STD/performx-app.conf" "$SSL/performx-app.conf"
  /scripts/rebuildhttpdconf > /dev/null 2>&1 || true
  httpd -t
  exit 1
fi
