#!/bin/sh
# Branche un domaine cPanel sur Suivi Agent (port 8090), sans risque pour les autres sites :
# la configuration est vérifiée avant tout redémarrage d'Apache, et retirée si elle échoue.
# Usage : sh cpanel/install.sh <utilisateur cPanel> <domaine>
set -eu
USER_NAME="$1"
DOMAIN="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
STD="/etc/apache2/conf.d/userdata/std/2_4/$USER_NAME/$DOMAIN"
SSL="/etc/apache2/conf.d/userdata/ssl/2_4/$USER_NAME/$DOMAIN"
mkdir -p "$STD" "$SSL"
cp "$HERE/http.conf" "$STD/suivi-agent.conf"
cp "$HERE/https.conf" "$SSL/suivi-agent.conf"
/scripts/ensure_vhost_includes --user="$USER_NAME"
/scripts/rebuildhttpdconf > /dev/null 2>&1 || true
if httpd -t; then
  /scripts/restartsrv_httpd
  echo "OK : $DOMAIN est branché sur Suivi Agent."
else
  echo "ERREUR : configuration refusée, retrait des fichiers (Apache n'a pas été redémarré)."
  rm -f "$STD/suivi-agent.conf" "$SSL/suivi-agent.conf"
  /scripts/rebuildhttpdconf > /dev/null 2>&1 || true
  httpd -t
  exit 1
fi
