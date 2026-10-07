import type { DocAudience } from '@suivi/shared';

export interface DefaultArticle {
  slug: string;
  section: string;
  title: string;
  summary: string;
  audience: DocAudience[];
  body: string;
  /** Rang dans le manuel ; sinon d'après l'ordre de la liste (10, 20, 30…) */
  position?: number;
}

const STAFF: DocAudience[] = ['admin', 'team_lead'];
const ADMIN: DocAudience[] = ['admin'];

/**
 * Manuel d'utilisation par défaut. Il décrit les écrans et les gestes, jamais le
 * fonctionnement interne. L'éditeur le modifie depuis sa console.
 */
export const DEFAULT_ARTICLES: DefaultArticle[] = [
  {
    slug: 'bienvenue',
    section: 'Prise en main',
    title: 'Bienvenue sur Suivi Agent',
    summary:
      'Les rôles, le back-office et l’application mobile en deux minutes.',
    audience: STAFF,
    body: `Suivi Agent vous aide à organiser et suivre vos équipes sur le terrain : où elles travaillent, ce qu’elles font, et ce qui demande votre attention.

## Trois rôles

- **Administrateur** : configure la structure (zones, groupes, utilisateurs, paramètres, abonnement) et voit tout.
- **Chef d’équipe** : suit son équipe en direct, valide les demandes de zone, crée des missions et traite les alertes.
- **Agent** : démarre sa journée dans sa zone depuis l’application mobile, remplit les formulaires de ses missions.

## Deux outils

- **Le back-office** (ce site) : pour les administrateurs et les chefs d’équipe, sur ordinateur.
- **L’application mobile** : pour les agents, et pour les chefs d’équipe sur le terrain.

## Par où commencer ?

Commencez par l’article **Avant de commencer : les prérequis**. Si vous êtes administrateur, suivez ensuite **Mettre en place votre structure**. Si vous êtes chef d’équipe, commencez par **La carte en temps réel** et **Les alertes**.`,
  },
  {
    slug: 'prerequis',
    section: 'Prise en main',
    title: 'Avant de commencer : les prérequis',
    summary:
      'Pas à pas, de la création du compte à la première journée : réglages, zones, équipes, agents, formulaires, missions, paie et application.',
    audience: STAFF,
    position: 15,
    body: `Ce guide vous accompagne de la création de votre compte jusqu’à la première journée de vos agents. Suivez les étapes dans l’ordre : chacune prépare la suivante. Comptez **une à deux heures** pour tout mettre en place.

> Astuce : le menu **Bien démarrer**, en haut à gauche, coche les étapes au fur et à mesure et vous emmène directement au bon écran.

[Ouvrir « Bien démarrer »](/start)

Dans chaque étape, les boutons ouvrent directement le bon écran, avec le formulaire de création prêt à remplir.

## Étape 0 — Ce qu’il vous faut avant de commencer

- **Un ordinateur** avec un navigateur à jour (Chrome, Edge, Firefox ou Safari) pour le back-office.
- **Un smartphone par agent** : Android 7 ou plus récent, ou iPhone sous iOS 13 ou plus récent, avec une **puce, un forfait data et un GPS qui fonctionne**.
- **Un smartphone par chef d’équipe** s’il suit son équipe sur le terrain.
- **La liste de vos agents** : prénom, nom et **numéro de téléphone** (c’est leur identifiant de connexion : un numéro par personne).
- **La liste de vos chefs d’équipe** : nom, numéro et adresse e-mail.
- **Vos secteurs** : les quartiers où vos agents travaillent.
- **Ce que vos agents notent à chaque visite** : nom du commerce, montant, produit… Ce seront vos formulaires.
- **Vos règles de paie** (si vous utilisez la rémunération) : fixe, montant par journée, par formulaire, primes, retenues.

## Étape 1 — Régler votre structure

Menu **Paramètres**.

[Ouvrir les paramètres](/settings)

1. Vérifiez le **fuseau horaire** (Afrique/Abidjan par défaut).
2. Choisissez la **durée de travail par jour** (8 h par défaut). C’est l’objectif affiché à chaque agent dans l’application.
3. Dans **Alertes des responsables**, indiquez l’**heure de début attendue** : un agent qui démarre après cette heure est signalé « en retard ».
4. Décidez si vous **utilisez des groupes** (une équipe = un chef + ses agents + ses zones). Recommandé dès que vous avez plus d’un chef.
5. Choisissez la **validation des zones** : automatique (l’agent choisit librement) ou par le chef.
6. Laissez activé **« Formulaires envoyés uniquement pendant une journée »** : c’est la garantie que le travail a bien été fait sur le terrain.
7. Cliquez sur **Enregistrer**.

## Étape 2 — Dessiner vos zones

Menu **Zones** → **Nouvelle zone**.

[Dessiner une zone](/zones?new=1) [Voir mes zones](/zones)

1. Donnez un **nom clair** (ex. « Cocody Angré »).
2. **Dessinez le contour** sur la carte, point par point, puis fermez la forme.
3. Indiquez une **capacité** si vous voulez limiter le nombre d’agents en même temps dans la zone (laissez vide sinon).
4. Recommencez pour chaque secteur. Deux zones ne doivent pas se chevaucher.

> Une zone rattachée à aucun groupe est une **zone libre** : tous les agents peuvent la choisir.

## Étape 3 — Créer vos chefs d’équipe et vos groupes

[Ajouter un chef d’équipe](/users?new=team_lead) [Créer un groupe](/groups?new=1) [Voir mes groupes](/groups)

1. Menu **Utilisateurs** → **Nouvel utilisateur**, rôle **Chef d’équipe** : nom, e-mail, numéro et mot de passe initial.
2. Menu **Groupes** → **Nouveau groupe** : nom de l’équipe (ex. « Équipe Nord ») et son **chef**.
3. Ouvrez le groupe et cochez ses **zones** : ses agents ne pourront choisir que celles-là (et les zones libres).
4. Si toute l’équipe travaille moins longtemps (demi-journée), réglez sa **durée de travail** dans le groupe.

## Étape 4 — Ajouter vos agents

Menu **Utilisateurs** → **Nouvel utilisateur**, rôle **Agent**.

[Ajouter un agent](/users?new=agent) [Voir mes agents](/users)

1. Renseignez prénom, nom, e-mail et **numéro de téléphone** (vérifiez-le bien : c’est son identifiant).
2. Choisissez son **groupe**.
3. Pour un temps partiel, réglez sa **durée de travail** (sinon, il garde celle de son groupe ou de la structure).
4. Donnez-lui un **mot de passe initial** : il pourra le changer depuis son profil.
5. Notez numéro et mot de passe pour les lui remettre.

## Étape 5 — Créer vos formulaires (types de missions)

Menu **Types de missions** → **Nouveau type**.

[Créer un type de mission](/mission-types?new=1) [Voir mes types](/mission-types)

1. Nommez le type (ex. « Prospection commerciale »).
2. Ajoutez les **champs** que l’agent remplit à chaque visite : texte, nombre, oui/non, date ou liste de choix.
3. Cochez **obligatoire** pour les informations indispensables.
4. Facultatif : réglez une **rémunération propre à ce type** (montant par formulaire, commission).

## Étape 6 — Lancer vos missions

Menu **Missions** → **Nouvelle mission**.

[Créer une mission](/missions?new=1) [Voir mes missions](/missions)

1. Choisissez le **type** (le formulaire) et donnez un **titre** clair (ex. « 200 visites à Adjamé »).
2. Écrivez les **consignes** : ce que l’agent doit faire, ce qu’il doit dire.
3. Choisissez **pour qui** : un agent, un groupe, ou **ouverte à tous** les agents qui travaillent dans ses zones.
4. Cochez **une ou plusieurs zones** : la mission se fait uniquement là. L’agent la voit en choisissant sa zone du jour, avec ses consignes et ce qu’elle lui rapporte.
5. Fixez l’**objectif** : un nombre de formulaires, une somme (ex. montant des commandes) ou une validation par le chef.
6. Ajoutez une **échéance**.

## Étape 7 — Régler la rémunération (si votre formule l’inclut)

Menu **Rémunération**.

[Créer une grille de paie](/pay?new=1) [Voir la rémunération](/pay)

1. Choisissez la **période de paie** (mensuelle par défaut).
2. Créez une **grille pour les agents** : fixe, montant par journée validée, par formulaire, primes d’objectif, retenues.
3. Créez une **grille pour les chefs** : fixe et prime selon le travail de leur équipe.
4. En fin de période, la paie se **calcule toute seule** : vous la vérifiez, la validez, puis la marquez payée.

## Étape 8 — Installer l’application sur les téléphones

À faire une fois, avec chaque agent :

[Personnaliser l’application](/branding) [Retrouver les numéros des agents](/users)

1. **Installer Suivi Agent** (lien fourni par votre administrateur).
2. Se connecter avec son **numéro de téléphone** et son mot de passe.
3. Autoriser la **localisation « Toujours »** (pas seulement « pendant l’utilisation »).
4. Autoriser les **notifications**.
5. Sur Android : **désactiver l’économie de batterie** pour Suivi Agent (Paramètres → Batterie → Suivi Agent → Non restreinte).
6. Laisser **la date et l’heure en automatique**.

## Étape 9 — La première journée

Côté agent, dans l’application :

1. **Choisir sa zone** : il voit les missions de chaque zone et ce qu’elles rapportent.
2. **Démarrer sa journée** en arrivant dans la zone.
3. **Remplir un formulaire** à chaque visite, depuis la mission (même sans réseau : l’envoi se fait au retour du réseau).
4. **Terminer sa journée** en partant.

Côté chef et administrateur, dans le back-office :

[Carte en temps réel](/map) [Alertes](/alerts) [Bilan du jour](/report) [Historique des journées](/history)

1. **Carte en temps réel** : où sont vos agents, qui est hors zone.
2. **Alertes** : retard, agent immobile, signal perdu, batterie faible, sortie de zone.
3. **Bilan du jour** : qui a travaillé, combien de temps (et le % de la durée prévue), combien de formulaires.
4. **Historique des journées** et **Missions** : la progression jour après jour.

## Avant de vous lancer : la liste de contrôle

- Les réglages sont enregistrés (fuseau, durée de travail, heure de début).
- Chaque agent a un **groupe** ou a accès à une **zone libre**.
- Chaque groupe a un **chef** et au moins **une zone**.
- Chaque mission a **au moins une zone** et un **objectif**.
- Chaque agent s’est **connecté une fois** à l’application, localisation « Toujours » autorisée.
- Vous avez fait un **essai d’une demi-journée** avec un ou deux agents.

[Contacter le support](/support)

> Expliquez à vos agents que leur position n’est partagée **que pendant leur journée de travail**, jamais en dehors. Une question ? Écrivez-nous depuis le menu **Support**.`,
  },
  {
    slug: 'mettre-en-place',
    section: 'Prise en main',
    title: 'Mettre en place votre structure',
    summary:
      'Les étapes pour être opérationnel : zones, équipes, comptes, réglages.',
    audience: ADMIN,
    body: `Comptez une heure pour une première mise en place.

1. **Dessinez vos zones** (menu *Zones*) : les secteurs où vos agents travaillent. Indiquez une capacité si vous voulez limiter le nombre d’agents par zone.
2. **Créez vos groupes** (menu *Groupes*, selon votre formule) : une équipe, son chef et les zones auxquelles elle a accès.
3. **Ajoutez les utilisateurs** (menu *Utilisateurs*) : chefs d’équipe et agents. Les agents se connectent à l’application avec leur **numéro de téléphone** et le mot de passe que vous leur communiquez.
4. **Réglez les paramètres** (menu *Paramètres*) : validation des zones, heure de remise à zéro, alertes des responsables.
5. **Personnalisez l’application** (menu *Application mobile*, selon votre formule) : logo, couleurs, message d’accueil.
6. **Faites installer l’application** à vos agents et testez une première journée avec l’un d’eux.

> Conseil : commencez avec une équipe pilote d’une semaine avant d’étendre à toute la structure.`,
  },
  {
    slug: 'carte-temps-reel',
    section: 'Terrain',
    title: 'La carte en temps réel',
    summary: 'Voir qui est en journée, où, et qui demande votre attention.',
    audience: STAFF,
    body: `La carte affiche les agents en journée et leurs zones. Elle se met à jour toute seule.

## Lire la carte

- **Pastille verte** : journée en cours. **Orange** : en pause. **Rouge** : une alerte (signal perdu, hors zone, immobile, batterie faible…).
- Les compteurs en haut de la liste filtrent d’un clic : *En cours*, *En pause*, *Alertes*.
- Filtrez par groupe, par zone ou cherchez un agent par son nom.

## La fiche d’un agent

Cliquez sur un agent pour ouvrir sa fiche : zone, heure de début, dernière position, batterie, précision du GPS. Le bouton **Voir le trajet** affiche son itinéraire de la journée.

## Bon à savoir

- Un agent n’apparaît pas tant qu’il n’a pas démarré sa journée.
- Pendant la pause, la position n’est pas partagée, sauf si votre structure l’a choisi (*Paramètres*).
- « Signal perdu » signifie que le téléphone n’envoie plus de position : GPS coupé, application fermée ou absence de réseau. Les positions enregistrées hors connexion arrivent dès le retour du réseau.`,
  },
  {
    slug: 'alertes',
    section: 'Terrain',
    title: 'Les alertes',
    summary: 'Les situations à surveiller, et comment les prendre en charge.',
    audience: STAFF,
    body: `Le menu *Alertes* rassemble les situations qui demandent l’attention d’un responsable. Le chef de l’agent est prévenu dès qu’une alerte s’ouvre ; elle se referme d’elle-même quand la situation se règle.

## Les types d’alertes

- **Signal perdu** : plus aucune position depuis le délai réglé.
- **Hors zone** : l’agent est sorti de sa zone au-delà du délai d’alerte. Une marge évite les fausses alertes en bordure.
- **Immobile** : pas de déplacement notable depuis un moment (hors pause).
- **Batterie faible** : le suivi risque de s’arrêter, prévenez l’agent.
- **Position simulée** : une application de fausse position GPS est utilisée.
- **Journée pas démarrée** : après l’heure de début attendue (à régler dans *Paramètres*).

## Prendre en charge

Cliquez sur **Je m’en occupe** et notez ce que vous avez fait (« Appelé : en rendez-vous client »). Les autres responsables voient que l’alerte est suivie. L’onglet *Refermées* garde l’historique des 7 derniers jours.

> Les seuils (délai, rayon, batterie) se règlent dans *Paramètres → Alertes des responsables*.`,
  },
  {
    slug: 'demandes-de-zone',
    section: 'Terrain',
    title: 'Les demandes de zone',
    summary: 'Valider, refuser ou réaffecter les agents dans les zones.',
    audience: STAFF,
    body: `Avant de démarrer sa journée, l’agent choisit une zone. Selon vos paramètres, la demande est acceptée automatiquement ou attend la validation de son responsable.

## Valider une demande

Le menu *Demandes de zone* liste les demandes en attente, avec leur délai d’expiration. **Accepter** confirme la place ; **Refuser** demande un motif, que l’agent voit.

## Réaffecter un agent

Le bouton **Réaffecter** déplace un agent vers une autre zone, même en cours de journée. Seul un administrateur peut dépasser la capacité d’une zone complète.

## Expiration

Une demande sans réponse expire au bout du délai réglé dans *Paramètres* : l’action prévue (accepter ou refuser) s’applique alors automatiquement.`,
  },
  {
    slug: 'journees',
    section: 'Terrain',
    title: 'Historique des journées et trajets',
    summary: 'Heures de début et de fin, pauses, trajets et sorties de zone.',
    audience: STAFF,
    body: `Le menu *Historique des journées* liste les journées de vos agents : début, pauses, fin et zone.

## Le trajet d’une journée

Cliquez sur **Trajet** : la carte montre l’itinéraire, le départ, la dernière position et les points hors zone ou simulés. En dessous, la liste des **sorties de zone** indique l’heure de sortie et de retour, la durée, la distance maximale et si le responsable a été prévenu.

## Journées oubliées

Si votre structure l’a choisi, les journées encore ouvertes sont terminées automatiquement à l’heure de remise à zéro.`,
  },
  {
    slug: 'zones',
    section: 'Organisation',
    title: 'Les zones',
    summary: 'Dessiner les secteurs de travail et fixer leur capacité.',
    audience: STAFF,
    body: `Une zone est un secteur dessiné sur la carte où un agent travaille pendant sa journée.

- **Créer** : cliquez sur *Nouvelle zone*, puis dessinez le contour point par point sur la carte. Deux zones ne peuvent pas se chevaucher.
- **Capacité** : nombre maximum d’agents en même temps. Laissez vide pour ne pas limiter.
- **Zone sensible** : peut demander une validation manuelle, même en mode mixte.
- **Désactiver** : la zone n’est plus proposée, son historique est conservé.

Les agents ne voient que les zones auxquelles leur groupe a accès.`,
  },
  {
    slug: 'equipes-et-comptes',
    section: 'Organisation',
    title: 'Groupes et utilisateurs',
    summary: 'Organiser les équipes, créer les comptes, gérer les accès.',
    audience: ADMIN,
    body: `## Groupes

Un groupe réunit des agents, leur chef d’équipe et les zones auxquelles ils ont accès. Le chef valide les demandes de son groupe et en reçoit les alertes. Sans groupe, les chefs d’équipe supervisent toute la structure.

## Utilisateurs

- Créez un compte par personne. Les agents et chefs se connectent à l’application avec leur **numéro de téléphone** ; ils ne peuvent pas le modifier eux-mêmes.
- **Désactiver** un compte bloque la connexion sans perdre l’historique.
- Le nombre d’agents actifs compte dans votre abonnement (menu *Agents actifs*).`,
  },
  {
    slug: 'missions',
    section: 'Organisation',
    title: 'Les missions',
    summary: 'Fixer des objectifs et recueillir des formulaires du terrain.',
    audience: STAFF,
    body: `Une mission fixe un objectif à un agent ou à un groupe, avec une échéance.

## Types de missions

Un type définit le formulaire que l’agent remplit à chaque visite ou action (texte, nombre, choix, photo…). Les administrateurs les créent dans *Types de missions*.

## Mesurer la progression

- **Nombre de formulaires** : chaque formulaire accepté compte pour 1.
- **Somme d’un champ** : par exemple le total des montants encaissés.
- **Validation manuelle** : le responsable déclare l’objectif atteint ou non.

## Suivre et corriger

Sur le détail de la mission : progression, contribution de chaque agent et formulaires reçus. Un formulaire incorrect peut être **rejeté** avec un motif : l’agent est prévenu et il ne compte plus.`,
  },
  {
    slug: 'remuneration',
    section: 'Organisation',
    title: 'La rémunération',
    summary: 'Grilles, rémunération par mission, paie de la période.',
    audience: STAFF,
    body: `La rémunération est calculée automatiquement à partir de l’activité réelle. **Aucun paiement ne passe par la plateforme** : vous exportez la paie, payez par vos moyens habituels, puis la marquez payée.

## Grilles

Une grille définit ce que gagne une personne : fixe, montant par journée validée, par formulaire accepté, commission, primes d’objectif, prime d’équipe pour les chefs, retenues et plafond. Elle s’applique à un rôle, un groupe ou une personne.

## Rémunération propre à une mission

Par défaut, une mission suit la grille de chaque agent. Un administrateur peut lui donner des **conditions propres** (prix par formulaire, commission, paliers de prime) qui remplacent la grille pour cette mission. Les agents voient sur la mission ce qu’elle leur rapporte.

## Paie de la période

À la fin de la période, la paie est calculée en brouillon. Les chefs peuvent proposer des primes ou retenues ; l’administrateur les accepte, valide la paie puis la marque payée. Chaque agent voit ses gains dans l’application.`,
  },
  {
    slug: 'parametres',
    section: 'Administration',
    title: 'Les paramètres de la structure',
    summary: 'Validation des zones, journée de travail, suivi, alertes.',
    audience: ADMIN,
    body: `Chaque paramètre a une valeur par défaut raisonnable ; ajustez-les à votre fonctionnement.

- **Validation des zones** : automatique, manuelle ou mixte (selon le taux de remplissage, les zones sensibles, les changements de zone…).
- **Journée de travail** : zone obligatoire pour démarrer, suivi pendant la pause (désactivé par défaut pour la vie privée), heure de remise à zéro, fin automatique des journées oubliées.
- **Suivi et données** : délai « signal perdu », marge autour des zones, délai d’alerte de sortie de zone, durée de conservation des positions.
- **Alertes des responsables** : activez chaque alerte et réglez ses seuils. L’alerte « journée pas démarrée » demande une heure de début et les jours travaillés.

Les modifications s’appliquent immédiatement, y compris dans l’application mobile.`,
  },
  {
    slug: 'abonnement',
    section: 'Administration',
    title: 'Abonnement et factures',
    summary: 'Formule, agents inclus, factures.',
    audience: ADMIN,
    body: `Le menu *Abonnement* montre votre formule, ce qu’elle inclut, le nombre de chefs et d’agents inclus, et vos factures.

- **Changer de formule** : les fonctionnalités s’ouvrent aussitôt (cadenas dans le menu sinon).
- **Agents supplémentaires** : au-delà des agents inclus, chaque agent actif est facturé selon votre formule.
- **Essai gratuit** : toutes les fonctionnalités sont ouvertes pendant l’essai.

Pour une question de facturation, écrivez au support (menu *Support*, catégorie « Facturation »).`,
  },
  {
    slug: 'application-agent',
    section: 'Application mobile',
    title: 'L’application pour les agents',
    summary: 'Journée, zone, missions et gains depuis le téléphone.',
    audience: ['admin', 'team_lead', 'agent'],
    body: `## Démarrer sa journée

1. Choisir sa zone (validée automatiquement ou par le responsable).
2. Appuyer sur **Démarrer** : la position est partagée jusqu’à la fin de la journée.
3. **Pause** et **Terminer** depuis le même écran.

## Ma zone

La carte de l’écran *Ma journée* montre la zone et la position de l’agent. Si l’agent sort de sa zone, il est averti tout de suite sur son téléphone, puis son responsable est prévenu au-delà du délai réglé.

## Missions et gains

L’onglet *Missions* liste les objectifs et permet de remplir les formulaires, même sans réseau : ils partent dès que la connexion revient. Si votre formule l’inclut, *Mes gains* montre l’estimation de la période et l’historique des paies.

> L’application doit avoir l’autorisation de localisation « Toujours » pour que le suivi continue écran éteint.`,
  },
  {
    slug: 'application-chef',
    section: 'Application mobile',
    title: 'L’application pour les chefs d’équipe',
    summary: 'L’équipe en direct, la carte, les demandes et les alertes.',
    audience: STAFF,
    body: `Le chef d’équipe retrouve l’essentiel du back-office sur son téléphone :

- **Mon équipe** : agents en journée, en pause, à surveiller, et pas encore partis (avec appel direct).
- **Carte** : positions, zones, itinéraire du jour d’un agent, styles de carte.
- **Demandes** : valider ou refuser les demandes de zone.
- **Alertes** : une carte par agent avec ses alertes ; *Je m’en occupe*, carte et appel depuis la fiche.
- **Missions** : créer, modifier, désactiver une mission ; suivre les formulaires de l’équipe.
- **Gains de l’équipe** : estimation de la période et propositions de prime ou de retenue.`,
  },
  {
    slug: 'support',
    section: 'Aide',
    title: 'Contacter le support',
    summary: 'Poser une question ou signaler un problème.',
    audience: STAFF,
    body: `Le menu *Support* vous permet d’écrire à l’équipe Suivi Agent.

1. Cliquez sur **Nouvelle demande**, choisissez une catégorie (question, problème, facturation, suggestion…) et décrivez la situation.
2. Vous êtes prévenu dès que le support répond ; la réponse apparaît dans le fil de la demande.
3. Répondez dans le même fil pour préciser ou relancer, puis **fermez** la demande une fois réglée.

Pour être aidé plus vite : indiquez l’écran concerné, le nom de l’agent ou de la mission, et ce que vous attendiez.`,
  },
];
