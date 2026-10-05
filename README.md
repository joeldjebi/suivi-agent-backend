# Back-end – Suivi Agent

API NestJS de la plateforme de suivi des agents terrain : PostgreSQL + PostGIS, Redis, Socket.IO.

## Démarrer

Prérequis : Node 20 (`nvm use` à la racine du dépôt) et Docker.

```bash
docker compose up -d
npm install

cd apps/backend
cp .env.example .env
npm run migration:run
npm run seed:demo
npm run start:dev
```

Swagger : **http://localhost:3000/api/docs**

## Données de démo avec activité

`npm run seed:demo` recrée la structure « Démo Abidjan » avec 14 jours de terrain et la journée en cours :
- **Organisation** : 3 groupes (Nord, Sud, Centre), 8 zones et 16 agents.
- **Historique** : environ 170 journées, avec pauses et journées oubliées terminées automatiquement, et environ 44 000 positions GPS (itinéraires, sorties de zone, coupures de signal, un agent avec des positions simulées).
- **Missions** : 8 missions, en cours, atteintes et échouées, avec environ 630 formulaires, dont quelques-uns rejetés.
- **Aujourd'hui** : des agents en cours, en pause, en signal perdu, hors zone ou en position simulée, une demande de zone en attente et des agents pas encore partis.

Les données sont reproductibles : chaque lancement produit le même résultat. Les itinéraires sont des marches aléatoires dans les zones, ils ne suivent pas les rues.
Le chef de l'Équipe Centre est `chef3@demo.ci` (`07 01 01 01 03`) ; les agents supplémentaires vont de `07 02 02 02 07` à `07 02 02 02 16`.

## Comptes de démo

Mot de passe de tous les comptes : `Password123!`. Sur le web, on se connecte avec l'email ou le numéro ; dans l'app mobile, avec le numéro.

| Rôle | Identifiant | Périmètre |
| --- | --- | --- |
| Administrateur (web) | admin@demo.ci | Toute la structure « Démo Abidjan » |
| Chef d'équipe (web et mobile) | chef1@demo.ci · 07 01 01 01 01 | Équipe Nord : zones Plateau (3 places) et Cocody (4 places, sensible) |
| Chef d'équipe (web et mobile) | chef2@demo.ci · 07 01 01 01 02 | Équipe Sud : zones Yopougon (2 places) et Marcory (illimitée) |
| Agents (mobile) | 07 02 02 02 01 à 07 02 02 02 03 | Équipe Nord |
| Agents (mobile) | 07 02 02 02 04 à 07 02 02 02 06 | Équipe Sud |

Le numéro est **obligatoire pour les agents et les chefs d'équipe**. Il est normalisé (`07 07 07 07 07`, `+225 07…` et `0707070707` désignent le même numéro) et unique sur toute la plateforme.
La démo est en mode d'approbation **automatique**, avec les groupes activés et une personnalisation de l'app (couleur `#0F766E`).

## Tester dans Swagger

1. `POST /api/auth/login` avec `{ "email": … }` ou `{ "phone": … }` et le mot de passe, puis copier `accessToken`.
2. Cliquer sur **Authorize** et coller le jeton.
3. Exemple de parcours agent (agent1) :
   - `GET /api/zones/available` : les zones de son groupe et les places restantes ;
   - `POST /api/zone-requests` avec `{ "zoneId": "…" }` ;
   - `POST /api/days/start`, puis `POST /api/positions/batch` :
     ```json
     { "dayId": "…", "points": [{ "lat": 5.32, "lng": -4.02, "accuracy": 10, "recordedAt": "2026-10-02T15:00:00Z" }] }
     ```
     (`recordedAt` doit être postérieur au démarrage de la journée) ;
   - `POST /api/days/pause`, `/resume`, `/end`.
4. Avec admin ou chef1 : `GET /api/live` pour la carte en temps réel, et `GET /api/days` pour l'historique.
5. Pour tester l'approbation : avec admin, `PATCH /api/settings` avec `{ "approvalMode": "manual" }`. Les demandes passent alors en attente : `GET /api/zone-requests?status=pending`, puis `POST /api/zone-requests/{id}/decision`.

Les erreurs métier renvoient un `code` stable (par exemple `ZONE_FULL`, `DAY_STARTED` ou `PENDING_APPROVAL`) que le web et le mobile pourront exploiter.

## Désactivation et suppression

Cinq types d'éléments ont des données liées : groupes, zones, utilisateurs, types de missions et missions. Pour eux, l'API distingue deux opérations :

| Opération | Appel | Effet |
| --- | --- | --- |
| Désactiver (recommandé) | `PATCH /<ressource>/:id` `{ "isActive": false }` | Réversible avec `{ "isActive": true }`. L'historique est conservé. |
| Mesurer l'impact | `GET /<ressource>/:id/impact` | Nombre de données liées, et `requiresForce` |
| Supprimer définitivement | `DELETE /<ressource>/:id` | Refusé avec `409 HAS_DEPENDENCIES` et le détail de l'impact s'il existe des données liées |
| Supprimer en cascade | `DELETE /<ressource>/:id?force=true` | Supprime aussi les données liées. Irréversible. |

Effets de la désactivation :
- **Utilisateur** : l'accès est coupé immédiatement, même avec un jeton encore valide, grâce à une révocation enregistrée dans Redis. Ses places dans les zones sont libérées. La même coupure s'applique en cas de suppression, de changement de rôle ou de changement de mot de passe.
- **Zone** : ses places sont libérées et les agents sont prévenus. La réouverture vérifie qu'elle ne chevauche aucune zone active.
- **Groupe** : ses agents ne voient plus ses zones, et son chef perd ses droits sur le groupe.
- **Type de mission** : il n'est plus proposé pour les nouvelles missions.
- **Mission** : elle n'est plus visible des agents et refuse les nouveaux formulaires.

Protections : on ne peut pas supprimer son propre compte, ni le dernier administrateur actif.

## Temps réel (Socket.IO)

```js
io('http://localhost:3000', { auth: { token: accessToken } })
```

| Événement | Reçu par |
| --- | --- |
| `agent:position` | administrateurs, chef du groupe de l'agent |
| `agent:status` | administrateurs, chef du groupe de l'agent |
| `zone-request:created` | approbateurs |
| `zone-request:decided` | l'agent concerné |
| `notification` | le destinataire |

## Tests

```bash
npm test
npm run test:e2e
npm run lint
```

Avant le premier `test:e2e`, appliquer la migration sur la base de test :
`DATABASE_NAME=suivi_agent_test npm run migration:run`.

## Architecture

- **Multi-tenant** : `tenant_id` sur chaque table et Row Level Security PostgreSQL. L'API se connecte avec le rôle `suivi_app`, qui n'est pas propriétaire des tables : la RLS s'applique donc toujours. Chaque requête HTTP s'exécute dans une transaction où `app.tenant_id` est positionné ([db.service.ts](src/common/db.service.ts)).
- **Places dans les zones** : une demande `pending` réserve une place, une demande `approved` l'occupe. Des index uniques partiels garantissent au plus une zone approuvée et une demande en attente par agent. La capacité est vérifiée sous verrou `FOR UPDATE` sur la zone.
- **Hors ligne** : les positions sont dédoublonnées sur `(agent, recordedAt)` et les formulaires sur `clientId`. Un renvoi après une coupure réseau ne crée donc pas de doublon.
- **Tâches planifiées** ([jobs.service.ts](src/jobs/jobs.service.ts)) :
  - chaque minute : relance et expiration des demandes, remise à zéro quotidienne ;
  - toutes les 5 minutes : missions échues ;
  - chaque nuit : purge des positions au-delà de la durée de conservation.

  Un verrou consultatif PostgreSQL protège chaque tâche si plusieurs instances de l'API tournent.
- **Dernière position** dans Redis (`live:<tenantId>`), historique complet dans la table `positions`.

## Règles de gestion

| Règles | Où |
| --- | --- |
| RG-01 à RG-03, RG-15 | [zones](src/zones) |
| RG-05 à RG-09, RG-16 à RG-20, RG-23, RG-24, RG-28 à RG-34 | [zone-requests](src/zone-requests) |
| RG-10 à RG-12, RG-21, RG-25 à RG-27 | [days](src/days), [positions](src/positions) |
| RG-13, RG-14, RG-35 à RG-39 | [missions](src/missions) |
| RG-22, RG-29, RG-30, RG-37 | [jobs](src/jobs) |
| RG-40 à RG-42 | [billing](src/billing) |

Reportés à plus tard : le back-office éditeur et la facturation (RG-43, RG-44), l'envoi push Firebase (branché sur `NotificationsService` avec l'app mobile), et la demande de changement de zone en cours de journée par l'agent.

## Abonnement des structures

- **Tarification au forfait** : chaque formule (`plans` : Base, Avancée, Entreprise) a un prix mensuel global qui inclut un quota de chefs d'équipe et d'agents actifs, et un prix par agent supplémentaire acheté au-delà (`subscriptions.extra_agents`). Essai gratuit de 14 jours (quotas Entreprise), remise sur l'engagement annuel (`platform_settings`). Montants provisoires, modifiables par l'éditeur (super administrateur).
- **Quotas** : comptes actifs (agents, chefs d'équipe ; l'administrateur ne compte pas). Créer, réactiver ou changer le rôle d'un compte au-delà du quota est refusé (409 `QUOTA_EXCEEDED`, avec `used` et `limit`). Les agents supplémentaires s'achètent depuis `PATCH /subscription { extraAgents }`.
- **Fonctionnalités par formule** (réglées par l'éditeur ; valeurs installées : `DEFAULT_PLAN_FEATURES` dans `@suivi/shared`) : Base = suivi, zones, journées, historique, app mobile ; Avancée = + groupes et chefs d'équipe, validation des zones, missions, personnalisation de l'app, exports ; Entreprise = + statistiques, suivi des chefs d'équipe, journal d'accès, rémunération. Pendant l'essai, tout est ouvert.
- **Contrôle d'accès** : `@RequiresFeature(...)` sur les routes réservées (402 `FEATURE_NOT_IN_PLAN` avec `requiredPlan`), et abonnement suspendu (402 `SUBSCRIPTION_SUSPENDED`) sauf routes `@AllowWhenSuspended` (authentification, abonnement). Voir [subscription.guard.ts](src/subscriptions/subscription.guard.ts).
- **Facture mensuelle** (tâche horaire, idempotente) : forfait + agents supplémentaires × prix, remise annuelle déduite, au prorata si l'essai se termine en cours de mois. Facture impayée après échéance (15 jours) → `past_due` (avertissement) ; 15 jours plus tard → `suspended` ; paiement enregistré → actif.
- **Changement de formule** : `PATCH /subscription`. L'engagement annuel court 12 mois. Une formule (ou un nombre d'agents supplémentaires) inférieure est refusée (409 `PLAN_DOWNGRADE_BLOCKED`, liste `blocking`) tant que la structure utilise des fonctionnalités ou des comptes qu'elle perdrait.
- Le paiement des factures est enregistré par l'éditeur depuis l'espace super administrateur (aucun paiement en ligne). Une structure aux conditions négociées ne change pas seule de formule (409 `CUSTOM_TERMS`).

## Rémunération des agents et chefs d'équipe (formule Entreprise)

- **Calcul automatique** à partir de l'activité réelle, aucune saisie : fixe, journées validées (sans position simulée, durée minimum, au moins 80 % des positions dans la zone si demandé), formulaires acceptés (montant par type), commission sur les montants saisis, primes d'objectif (missions arrivées à échéance dans la période), prime d'équipe pour le chef, retenues (journées non clôturées, formulaires rejetés, positions simulées) et plafond. Voir [payroll.calculator.ts](src/payroll/payroll.calculator.ts).
- **Grilles** (`/pay/grids`) : une grille attribuée à une personne l'emporte sur celle de son groupe, qui l'emporte sur celle du rôle.
- **Période** mensuelle par défaut (ou hebdomadaire, quinzaine) dans `/pay/settings`. Estimation en direct : `GET /pay/current` (admin, chef pour son équipe) et `GET /pay/me` (agent, chef).
- **Paies** : préparées automatiquement en brouillon à la fin de la période (tâche horaire), ou via `POST /pay/runs` (409 `PERIOD_NOT_OVER` sinon). Brouillon → recalcul possible ; validée (409 `PENDING_ADJUSTMENTS` s'il reste des ajustements proposés, puis 409 `RUN_LOCKED` pour tout recalcul) → payée, ligne par ligne avec référence.
- **Ajustements** : l'administrateur les ajoute directement ; le chef d'équipe les propose pour son équipe et l'administrateur les approuve ou les rejette.
- **Aucun paiement dans la plateforme** : on exporte un fichier de paiement (Mobile Money, banque) et un export comptable, puis on enregistre les paiements effectués. Les personnes sont notifiées à la validation et au paiement.

## Espace éditeur (super administrateur)

- **Comptes à part** (`platform_admins`), hors de toute structure : connexion `POST /platform/auth/login` (email + mot de passe), session de 10 h. Le jeton est signé avec un secret distinct (`PLATFORM_JWT_SECRET`, sinon dérivé de `JWT_SECRET`) : un jeton de structure n'ouvre jamais `/platform/*`, et inversement. Premier compte : `npm run platform:admin -- email 'mot de passe' Prénom Nom`. Démo : `sa@suivi.ci` / `Password123!` (`npm run seed -- --platform` l'ajoute sans toucher à la démo existante, avec un portefeuille de 6 structures clientes).
- **Accès protégé** : après 5 échecs de connexion pour un compte (20 pour une adresse IP) en 15 minutes, la connexion est refusée même avec le bon mot de passe (429 `TOO_MANY_ATTEMPTS`). `PLATFORM_ALLOWED_IPS` (adresses séparées par des virgules) réserve l'espace à certaines adresses : les autres reçoivent 404. Derrière un proxy, régler `TRUST_PROXY` (ex. `1`). En production (`NODE_ENV=production`), ces routes sont absentes de Swagger. Côté web, la console vit à une adresse secrète (`VITE_PLATFORM_PATH`).
- **Double authentification** (TOTP : Google Authenticator, Microsoft Authenticator, 1Password) : mise en place par QR code (`POST /platform/auth/mfa/setup`, puis `mfa/enable` avec un premier code), 8 codes de secours à usage unique. Une fois active, `POST /platform/auth/login` renvoie `mfaRequired` et un `mfaToken` valable 5 minutes, à échanger contre la session avec le code (`POST /platform/auth/login/mfa`). Un code ne sert qu'une fois ; les échecs comptent dans le verrouillage. Secret chiffré en base (AES-256-GCM, `PLATFORM_MFA_KEY`). Téléphone perdu : un autre compte éditeur réinitialise (`POST /platform/admins/:id/mfa-reset`). Avec `PLATFORM_REQUIRE_MFA=true`, un compte sans double authentification n'accède qu'à sa mise en place (403 `MFA_SETUP_REQUIRED`) et ne peut pas la désactiver.
- **Tableau de bord** (`GET /platform/dashboard`) : structures par statut, revenu mensuel récurrent (MRR, prix négociés et remise annuelle compris) et par formule, factures en attente et échues, encaissements, 12 derniers mois (facturé, encaissé, inscriptions), utilisation, essais qui se terminent, impayés.
- **Structures** : liste filtrable (recherche nom, email ou numéro, statut, formule, impayés ; tri), création d'une structure cliente (essai ou formule directe), détail (abonnement, quotas, activité sur 30 jours, factures, historique), notes internes.
- **Abonnement** (`PATCH /platform/tenants/:id/subscription`) : formule, cycle, agents supplémentaires, **conditions négociées** (prix mensuel, quotas d'agents et de chefs ; `null` = ceux de la formule), prolongation de l'essai. Pas de blocage : les dépassements de quotas sont renvoyés dans `warnings`.
- **Suspension manuelle** avec motif (la régularisation des factures ne la lève pas) et réactivation ; les administrateurs de la structure sont notifiés (notifications lisibles même suspendu).
- **Factures** : liste de toutes les structures (statut, mois, échues, recherche), **paiement reçu hors plateforme** (`mobile_money`, `transfer`, `cash`, `other`, référence, date) et annulation motivée ; le statut de la structure est recalculé aussitôt.
- **Catalogue et réglages** : l'éditeur crée, modifie, retire ou supprime (si aucune structure ne l'a) des formules : nom, description, prix, quotas et **avantages** (`plans.features`, parmi les fonctionnalités de l'application `Feature`). Avantages et quotas s'appliquent aussitôt à toutes les structures de la formule (la réponse signale celles qui perdent un avantage qu'elles utilisent) ; les prix, aux prochaines factures. Réglages : durée d'essai, formule dont l'essai prend les quotas (`trialPlanCode`), formule attribuée après l'essai (`defaultPlanCode`), remise annuelle, échéance, délai de suspension. Un refus 402 `FEATURE_NOT_IN_PLAN` indique la formule proposée la moins chère qui inclut la fonctionnalité (`requiredPlan`, `requiredPlanName`) ; `/auth/me` la donne pour chaque fonctionnalité absente (`subscription.upgrades`).
- **Journal** (`GET /platform/audit`) : toutes les actions de l'éditeur, y compris les connexions refusées.

## Site vitrine (modulable par l'éditeur)

- **Contenu** (`landing_pages`) : identité, référencement, en-tête et sections ordonnées (chiffres, fonctionnalité illustrée, récit au défilement, profils, tarifs, témoignages, questions, appel final), pied de page. Format : `LandingContent` dans `@suivi/shared`. Chaque envoi est vérifié champ par champ (`landing.sanitize.ts` : champs connus seulement, longueurs bornées, liens en https, texte jamais interprété comme du HTML).
- **Brouillon puis publication** : `PUT /platform/landing` (enregistrement du brouillon), `GET /platform/landing/preview`, `POST /platform/landing/publish`, `DELETE /platform/landing/draft` (abandon), `POST /platform/landing/restore-defaults`. Contenu d'origine : `landing.defaults.ts`.
- **Images** : `POST /platform/landing/assets` (PNG, JPEG, WebP, 2 Mo, reconnus à leur signature), servies sur `GET /api/public/landing/assets/:id` (cache immuable).
- **Public** : `GET /api/public/landing` (contenu publié + formules proposées du catalogue, devise, durée d'essai, remise annuelle ; cache d'une minute vidé à la publication).
- **Demandes de démo** : `POST /api/public/demo-requests` (champ piège contre les robots, 5 demandes par heure et par adresse IP), suivies dans la console (`GET/PATCH /platform/demo-requests`, statuts nouvelle, contactée, devenue cliente, sans suite, notes).
