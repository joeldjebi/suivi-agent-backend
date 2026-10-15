/**
 * Prise de commande terrain : l'agent prend la commande chez le point de vente, la livre lui-même,
 * puis l'encaisse. Pas de gestion de crédit : seulement des statuts.
 */
export const OrderStatus = {
  /** Prise chez le point de vente */
  Taken: 'taken',
  Delivered: 'delivered',
  Paid: 'paid',
  Cancelled: 'cancelled',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  taken: 'Prise',
  delivered: 'Livrée',
  paid: 'Payée',
  cancelled: 'Annulée',
};

/**
 * Passages possibles d'un statut à l'autre. Une commande payée sur place passe directement de
 * « prise » à « payée » (elle est alors aussi livrée). Payée ou annulée : terminée.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  taken: ['delivered', 'paid', 'cancelled'],
  delivered: ['paid', 'cancelled'],
  paid: [],
  cancelled: [],
};

/** Numéro lisible d'une commande : CMD-000042. */
export const orderNumber = (n: number) => `CMD-${String(n).padStart(6, '0')}`;
