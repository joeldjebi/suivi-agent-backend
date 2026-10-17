#!/bin/sh
# Branche un domaine cPanel sur PerformX (port 8090), sans risque pour les autres sites :
# la configuration est vérifiée avant tout redémarrage d'Apache, et retirée si elle échoue.
# Usage : sh cpanel/install.sh <utilisateur cPanel> <domaine> [adresse secrète de pgAdmin]
# Avec l'adresse de pgAdmin (ex. /db-7k2m9q4x, voir PGADMIN_PATH dans .env), l'interface de la
# base est servie à cette adresse, derrière un mot de passe demandé au premier lancement
# (fichier /etc/apache2/performx-db.htpasswd). DB_ALLOW_IP=1.2.3.4 la limite à une adresse IP.
set -eu
USER_NAME="$1"
DOMAIN="$2"
DB_PATH="${3:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
STD="/etc/apache2/conf.d/userdata/std/2_4/$USER_NAME/$DOMAIN"
SSL="/etc/apache2/conf.d/userdata/ssl/2_4/$USER_NAME/$DOMAIN"
HTPASSWD_FILE=/etc/apache2/performx-db.htpasswd
mkdir -p "$STD" "$SSL"
cp "$HERE/http.conf" "$STD/suivi-agent.conf"

if [ -n "$DB_PATH" ]; then
  if ! echo "$DB_PATH" | grep -Eq '^/db-[A-Za-z0-9]{8,}$'; then
    echo "ERREUR : adresse de pgAdmin invalide ($DB_PATH). Exemple : /db-7k2m9q4x"
    exit 1
  fi
  if [ ! -s "$HTPASSWD_FILE" ]; then
    HTPASSWD="$(command -v htpasswd || echo /usr/local/apache/bin/htpasswd)"
    echo "Mot de passe d'accès à la base (identifiant : performx) :"
    "$HTPASSWD" -cB "$HTPASSWD_FILE" performx
    chmod 644 "$HTPASSWD_FILE"
  fi
  if [ -n "${DB_ALLOW_IP:-}" ]; then
    ACCESS="  <RequireAll>
    Require valid-user
    Require ip $DB_ALLOW_IP
  </RequireAll>"
  else
    ACCESS="  Require valid-user"
  fi
  # Avant la règle générale « ProxyPass / » : la première règle qui correspond l'emporte.
  {
    cat <<EOF
RedirectMatch 301 ^$DB_PATH\$ $DB_PATH/
<Location "$DB_PATH/">
  AuthType Basic
  AuthName "Base PerformX"
  AuthUserFile "$HTPASSWD_FILE"
$ACCESS
  # Pages d'erreur de cPanel (401.shtml…) : elles passeraient par le site et répondraient 200,
  # sans que le navigateur demande le mot de passe.
  ErrorDocument 401 default
  ErrorDocument 403 default
  RequestHeader unset Authorization
</Location>
ProxyPass $DB_PATH/ http://127.0.0.1:8091$DB_PATH/
ProxyPassReverse $DB_PATH/ http://127.0.0.1:8091$DB_PATH/
EOF
    cat "$HERE/https.conf"
  } > "$SSL/suivi-agent.conf"
else
  cp "$HERE/https.conf" "$SSL/suivi-agent.conf"
fi

/scripts/ensure_vhost_includes --user="$USER_NAME"
/scripts/rebuildhttpdconf > /dev/null 2>&1 || true
if httpd -t; then
  /scripts/restartsrv_httpd
  echo "OK : $DOMAIN est branché sur PerformX."
  [ -n "$DB_PATH" ] && echo "Base : https://$DOMAIN$DB_PATH/"
  exit 0
else
  echo "ERREUR : configuration refusée, retrait des fichiers (Apache n'a pas été redémarré)."
  rm -f "$STD/suivi-agent.conf" "$SSL/suivi-agent.conf"
  /scripts/rebuildhttpdconf > /dev/null 2>&1 || true
  httpd -t
  exit 1
fi
