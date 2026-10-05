# Déploiement de Suivi Agent

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
- Sauvegarde de la base :
  `docker compose -f docker-compose.prod.yml exec -T db pg_dump -U suivi suivi_agent | gzip > sauvegarde-$(date +%F).sql.gz`

## Nom de domaine (plus tard)

Pointer le domaine vers le serveur, puis passer en HTTPS (Let's Encrypt) devant le port
`PUBLIC_PORT`, et mettre `CORS_ORIGIN=https://le-domaine` dans `.env`.
