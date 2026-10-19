# Déploiement de PerformX

Toute l'application tourne dans ses propres conteneurs Docker (base PostGIS, Redis, API,
site web) et n'est exposée que sur **un seul port** (`PUBLIC_PORT`, 8090 par défaut). Rien
n'est partagé avec les autres projets du serveur.

## Première installation

```
mkdir -p /opt/suivi-agent && cd /opt/suivi-agent
git clone https://github.com/joeldjebi/suivi-agent-backend.git
git clone https://github.com/joeldjebi/suivi-agent-frontend.git
cd suivi-agent-backend/deploy
cp env.production.example .env
nano .env
docker compose -f docker-compose.prod.yml up -d --build
```

Dans `.env`, remplacer chaque `À_REMPLACER` (secrets : `openssl rand -hex 32`).

Compte éditeur (super administrateur) :

```
docker compose -f docker-compose.prod.yml exec api node dist/database/platform-admin.js email@exemple.ci 'MotDePasseLong' Prénom Nom
```

## Notifications push (clé Firebase)

La clé de service Firebase ne passe jamais par Git. Depuis le poste qui la détient :

```
ssh root@SERVEUR "mkdir -p /opt/suivi-agent/suivi-agent-backend/deploy/secrets"
scp firebase-service-account.json root@SERVEUR:/opt/suivi-agent/suivi-agent-backend/deploy/secrets/firebase-service-account.json
```

Puis sur le serveur : la clé doit appartenir à l'utilisateur de l'API dans son conteneur
(`node`, identifiant 1000), lisible par lui seul.

```
chown -R 1000:1000 /opt/suivi-agent/suivi-agent-backend/deploy/secrets
chmod 700 /opt/suivi-agent/suivi-agent-backend/deploy/secrets
chmod 600 /opt/suivi-agent/suivi-agent-backend/deploy/secrets/firebase-service-account.json
```

Ajouter `FIREBASE_SERVICE_ACCOUNT_FILE=/app/secrets/firebase-service-account.json` dans `.env`,
redémarrer l'API, et vérifier « Notifications push activées » dans ses journaux.

## Mise à jour

```
cd /opt/suivi-agent/suivi-agent-backend && git pull
cd ../suivi-agent-frontend && git pull
cd ../suivi-agent-backend/deploy && docker compose -f docker-compose.prod.yml up -d --build
```

Les migrations de la base s'appliquent automatiquement au démarrage de l'API.

## Exploitation

- État : `docker compose -f docker-compose.prod.yml ps`
- Journaux : `docker compose -f docker-compose.prod.yml logs -f api`
- Santé : `curl http://localhost:8090/api/health`
- Journaux limités à 3 × 10 Mo par conteneur : le disque ne se remplit pas.

## Sauvegardes

Le service `backup` copie la base chaque nuit à 2 h (UTC, heure d'Abidjan), vérifie la
copie et garde les 14 derniers jours dans `/opt/suivi-agent/backups` (hors du code). Une
copie est aussi faite à son premier démarrage.

- Voir les copies : `ls -lh /opt/suivi-agent/backups`
- Journal : `docker compose -f docker-compose.prod.yml logs backup` (« OK » ou « ÉCHEC »)
- Copie immédiate (avant une opération délicate) :
  `docker compose -f docker-compose.prod.yml exec backup sh -c 'pg_dump -Fc -f /backups/suivi-agent_$(date -u +%F_%H%M).dump'`

**Restauration** (remplace toute la base, l'API est arrêtée pendant l'opération) :

```
cd /opt/suivi-agent/suivi-agent-backend/deploy
sh restore.sh
sh restore.sh suivi-agent_2026-10-16_0200.dump
```

La première commande liste les copies ; la seconde restaure celle choisie après
confirmation (taper `OUI`).

**Copie hors du serveur** : les copies sont sur le même disque que la base ; une panne du
serveur les emporterait aussi. Les rapatrier régulièrement ailleurs, par exemple depuis un
autre poste :

```
scp root@SERVEUR:/opt/suivi-agent/backups/suivi-agent_*.dump ./sauvegardes/
```

## Nom de domaine et HTTPS (serveur cPanel)

Apache (géré par cPanel) tient les ports 80 et 443 pour tous les sites du serveur ; il
reçoit le domaine, s'occupe du certificat (AutoSSL) et renvoie vers le port `PUBLIC_PORT`.
Les autres sites ne sont pas touchés.

1. DNS du domaine : enregistrements **A** `@` et `www` vers l'adresse du serveur (et aucun
   AAAA ailleurs).
2. WHM → *Create a New Account* : domaine `performx.online`, utilisateur `performx`.
3. WHM → *Manage AutoSSL* → *Manage Users* → `performx` → *Check*. Attendre que le
   certificat soit émis (cPanel → *SSL/TLS Status*).
4. Modules Apache nécessaires (WHM → *EasyApache 4* sinon : mod_proxy, mod_proxy_http,
   mod_proxy_wstunnel, mod_headers) :
   `httpd -M | grep -E 'proxy_module|proxy_http|proxy_wstunnel|headers'`
5. Renvoi vers l'application (configuration vérifiée avant le redémarrage d'Apache, et
   retirée si elle est refusée : les autres sites ne sont jamais coupés) :
   `sh cpanel/install.sh performx performx.online`
   Le filtre ModSecurity est désactivé pour ce seul domaine (l'application valide déjà ses
   données ; ses règles génériques bloqueraient des envois normaux), et la politique de
   sécurité (Content-Security-Policy) posée globalement par Apache pour d'autres sites est
   retirée : elle bloquait le fond de carte (OpenStreetMap).

6. Dans `.env` : `CORS_ORIGIN=https://performx.online,https://www.performx.online,http://185.215.167.87:8090`
   puis `docker compose -f docker-compose.prod.yml up -d api`.

Vérifier : `curl -sI https://performx.online/api/health` (réponse 200).

**Port 8090 fermé au public** (par défaut) : il n'écoute que sur 127.0.0.1, où Apache le
joint. Pour le rouvrir le temps que d'anciens téléphones se mettent à jour, mettre
`PUBLIC_BIND=0.0.0.0` dans `.env` puis `docker compose -f docker-compose.prod.yml up -d web`.

## Interface web de la base (pgAdmin, facultative)

Consultation de la base depuis un navigateur, à une adresse secrète, derrière deux mots de
passe (celui d'Apache, puis le compte pgAdmin). pgAdmin n'écoute que sur 127.0.0.1:8091.

1. Dans `.env` :
   ```
   COMPOSE_PROFILES=dbadmin
   PGADMIN_PATH=/db-<au moins 8 lettres ou chiffres>
   PGADMIN_EMAIL=vous@exemple.com
   PGADMIN_PASSWORD=<mot de passe long>
   ```
2. `docker compose -f docker-compose.prod.yml up -d pgadmin`
3. Règle Apache (le mot de passe d'accès, identifiant `performx`, est demandé la première
   fois) : `sh cpanel/install.sh performx performx.online /db-…` avec la même adresse.
   Pour limiter l'accès à une adresse IP : `DB_ALLOW_IP=1.2.3.4 sh cpanel/install.sh …`.
4. Ouvrir `https://performx.online/db-…/`, se connecter avec `PGADMIN_EMAIL`, ouvrir le
   serveur « PerformX » : le mot de passe demandé est `DATABASE_PASSWORD`.

Changer le mot de passe Apache : `htpasswd -B /etc/apache2/performx-db.htpasswd performx`.
Désactiver : retirer `COMPOSE_PROFILES`, `docker compose -f docker-compose.prod.yml stop pgadmin`,
puis relancer `sh cpanel/install.sh performx performx.online` sans l'adresse.

## Version web de l'app (app.performx.online, facultative)

Le même code que l'app mobile, compilé pour le navigateur (agents et chefs d'équipe). Sur le
web, la position n'est suivie que tant que la page est ouverte : l'app mobile reste
nécessaire pour le suivi écran éteint.

1. DNS : enregistrement **A** `app` vers l'adresse du serveur.
2. cPanel (compte `performx`) → *Domains* → *Create A New Domain* : `app.performx.online`,
   puis WHM → *Manage AutoSSL* → `performx` → *Check* (certificat du sous-domaine).
3. Code de l'app à côté des deux autres dépôts :
   `cd /opt/suivi-agent && git clone https://github.com/joeldjebi/suivi-agent-app-mobile.git`
4. Dans `.env` : ajouter `webapp` à `COMPOSE_PROFILES` (ex. `COMPOSE_PROFILES=dbadmin,webapp`).
5. `docker compose -f docker-compose.prod.yml up -d --build app` (première construction :
   quelques minutes, image Flutter).
6. `sh cpanel/install-app.sh performx app.performx.online`

Mise à jour : `cd /opt/suivi-agent/suivi-agent-app-mobile && git pull`, puis l'étape 5.

## Distribution directe de l'app (en attendant les stores)

Page publique : `https://performx.online/telecharger` (lien en bas du site). Ses boutons
suivent les liens réglés dans la console éditeur (Réglages → Application mobile).

- **Android (APK)** : construire `flutter build apk --release` (dossier de l'app mobile),
  copier le fichier sur le serveur dans `/opt/suivi-agent/downloads/performx.apk`, puis
  régler le lien Android sur `https://performx.online/downloads/performx.apk`.
- **iPhone (TestFlight)** : App Store Connect → TestFlight → *Testeurs externes* → lien
  public ; le coller comme lien iPhone.
