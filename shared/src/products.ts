/**
 * Catalogue de produits de la structure (les siens et ceux de la concurrence) et relevés par
 * produit pendant les visites : présence, stock, prix, ventes, pertes, commandes.
 */

/** Ce que l'agent relève pour chaque produit. */
export const ProductMeasure = {
  /** Présent en rayon (non : rupture) */
  Presence: 'presence',
  /** Stock compté, en unités de base */
  Stock: 'stock',
  /** Prix de vente constaté, par unité de base */
  Price: 'price',
  /** Quantité vendue depuis la dernière visite, en unités de base */
  Sold: 'sold',
  /** Pertes (périmé, cassé, volé), en unités de base */
  Losses: 'losses',
  /** Quantité commandée, en unités de base */
  Ordered: 'ordered',
} as const;
export type ProductMeasure = (typeof ProductMeasure)[keyof typeof ProductMeasure];

export const PRODUCT_MEASURE_LABELS: Record<ProductMeasure, string> = {
  presence: 'Présent / rupture',
  stock: 'Stock',
  price: 'Prix de vente',
  sold: 'Quantité vendue',
  losses: 'Pertes',
  ordered: 'Quantité commandée',
};

/** Produits concernés par un relevé. */
export const ProductScope = {
  All: 'all',
  Own: 'own',
  Competitor: 'competitor',
  Selected: 'selected',
} as const;
export type ProductScope = (typeof ProductScope)[keyof typeof ProductScope];

export interface ProductFieldConfig {
  scope: ProductScope;
  /** Produits choisis (scope « selected ») */
  productIds?: string[];
  /** Limiter à une catégorie du catalogue */
  category?: string | null;
  measures: ProductMeasure[];
}

/** Conditionnement : « Casier = 12 bouteilles ». */
export interface Packaging {
  name: string;
  units: number;
}

/** Unités de base proposées ; la structure peut en saisir d'autres. */
export const PRODUCT_UNITS = [
  'Unité',
  'Bouteille',
  'Canette',
  'Sachet',
  'Paquet',
  'Pièce',
  'Boîte',
  'Kg',
  'Litre',
] as const;

/** Conditionnements proposés. */
export const PACKAGING_NAMES = ['Carton', 'Casier', 'Pack', 'Sac', 'Boîte', 'Cartouche', 'Fardeau'] as const;

/** Valeur d'un relevé : pour chaque produit, les mesures saisies. */
export type ProductReadings = Record<string, Partial<Record<ProductMeasure, number | boolean>>>;
