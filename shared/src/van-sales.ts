/**
 * Vente en camionnette : le stock vit dans des emplacements (dépôts, camions) ; chaque
 * entrée ou sortie est un mouvement. L'agent vend depuis son camion (vente directe : livrée
 * et payée sur place, en tout ou partie, le reste à crédit dans la limite du plafond du
 * client) et remet chaque soir l'argent encaissé en espèces.
 */
export const StockLocationKind = {
  Depot: "depot",
  Van: "van",
} as const;
export type StockLocationKind =
  (typeof StockLocationKind)[keyof typeof StockLocationKind];

export const STOCK_LOCATION_KIND_LABELS: Record<StockLocationKind, string> = {
  depot: "Dépôt",
  van: "Camion",
};

export const StockMovementKind = {
  /** Entrée au dépôt (livraison du fournisseur, production) */
  Receipt: "receipt",
  /** Chargement : dépôt → camion, confirmé par l'agent à la réception */
  Load: "load",
  /** Retour au dépôt : camion → dépôt, confirmé par un responsable */
  Unload: "unload",
  /** Vente directe depuis le camion */
  Sale: "sale",
  /** Annulation d'une vente : la marchandise revient dans le camion */
  SaleCancel: "sale_cancel",
  /** Casse, perte, vol, produit périmé */
  Loss: "loss",
  /** Inventaire : quantité comptée, l'écart corrige le stock */
  Adjustment: "adjustment",
  /** Dépannage : camion → camion d'un collègue, remis en main propre (code scanné) */
  Transfer: "transfer",
} as const;
export type StockMovementKind =
  (typeof StockMovementKind)[keyof typeof StockMovementKind];

export const STOCK_MOVEMENT_KIND_LABELS: Record<StockMovementKind, string> = {
  receipt: "Entrée au dépôt",
  load: "Chargement",
  unload: "Retour au dépôt",
  sale: "Vente",
  sale_cancel: "Vente annulée",
  loss: "Casse ou perte",
  adjustment: "Inventaire",
  transfer: "Dépannage",
};

export const StockMovementStatus = {
  /** En attente de confirmation (chargement, retour) */
  Pending: "pending",
  Done: "done",
  Cancelled: "cancelled",
} as const;
export type StockMovementStatus =
  (typeof StockMovementStatus)[keyof typeof StockMovementStatus];

export const PaymentMethod = {
  Cash: "cash",
  MobileMoney: "mobile_money",
  /** Virement, chèque */
  Bank: "bank",
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "Espèces",
  mobile_money: "Mobile money",
  bank: "Virement ou chèque",
};

export const OrderKind = {
  /** Commande prise, livrée plus tard */
  Order: "order",
  /** Vente directe depuis le camion : livrée sur place */
  Sale: "sale",
} as const;
export type OrderKind = (typeof OrderKind)[keyof typeof OrderKind];

/** Signalements d'une vente enregistrée sans réseau, à vérifier par un responsable. */
export const SaleFlag = {
  /** Le camion n'avait pas (ou plus) assez de stock selon le serveur */
  NegativeStock: "negative_stock",
  /** Le crédit accordé dépasse le plafond du client */
  OverCreditLimit: "over_credit_limit",
  /** Client hors des zones de l'agent (urgence, motif donné) */
  OutOfZone: "out_of_zone",
} as const;
export type SaleFlag = (typeof SaleFlag)[keyof typeof SaleFlag];

export const SALE_FLAG_LABELS: Record<SaleFlag, string> = {
  negative_stock: "Stock du camion insuffisant",
  over_credit_limit: "Plafond de crédit dépassé",
  out_of_zone: "Vente hors zone",
};

/**
 * Dépannage entre camions (partagé) : l'agent en rupture liste ce qu'il lui faut ; la demande
 * est diffusée aux collègues proches qui ont ces produits. Chacun peut prendre une part (tout
 * ou partie) : elle est réservée pour lui, le reste reste ouvert aux autres. Sur place, chaque
 * collègue scanne le code du demandeur et remet sa part (le stock passe d'un camion à l'autre).
 */
export const TransferStatus = {
  /** Il reste des produits à trouver */
  Open: "open",
  /** Tout est réservé par des collègues, en attente des remises */
  Covered: "covered",
  /** Tout a été remis */
  Done: "done",
  /** Clos par le demandeur (« j'ai ce qu'il me faut ») */
  Closed: "closed",
  /** Fermée automatiquement (délai dépassé) */
  Expired: "expired",
} as const;
export type TransferStatus =
  (typeof TransferStatus)[keyof typeof TransferStatus];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  open: "En recherche",
  covered: "Tout est réservé",
  done: "Terminé",
  closed: "Clos",
  expired: "Expiré",
};

/** Part prise par un collègue dans une demande de dépannage. */
export const TransferLegStatus = {
  /** Collègue d'une autre équipe : en attente de l'accord de son chef */
  Approval: "approval",
  /** Réservée : le collègue vient la remettre */
  Accepted: "accepted",
  /** Remise (code scanné) */
  Done: "done",
  /** Libérée : abandonnée par le collègue, délai dépassé ou demande close */
  Released: "released",
  /** Refusée par le chef du collègue */
  Rejected: "rejected",
} as const;
export type TransferLegStatus =
  (typeof TransferLegStatus)[keyof typeof TransferLegStatus];

export const TRANSFER_LEG_STATUS_LABELS: Record<TransferLegStatus, string> = {
  approval: "En attente du chef",
  accepted: "Réservée",
  done: "Remise",
  released: "Libérée",
  rejected: "Refusée par le chef",
};
