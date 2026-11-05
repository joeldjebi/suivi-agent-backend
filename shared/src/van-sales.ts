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
} as const;
export type SaleFlag = (typeof SaleFlag)[keyof typeof SaleFlag];

export const SALE_FLAG_LABELS: Record<SaleFlag, string> = {
  negative_stock: "Stock du camion insuffisant",
  over_credit_limit: "Plafond de crédit dépassé",
};
