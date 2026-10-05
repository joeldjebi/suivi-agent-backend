# Image de production de l'API (à construire depuis le dépôt suivi-agent-backend).
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY shared ./shared
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Migrations (rôle propriétaire) puis démarrage de l'API (rôle applicatif, sous RLS).
CMD ["sh", "-c", "npx typeorm migration:run -d dist/database/data-source.js && node dist/main"]
