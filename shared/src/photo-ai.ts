/**
 * IA photo : résultat de l'analyse d'une photo de rayon. Les valeurs proposées par l'IA
 * pré-remplissent les relevés produits ; l'agent ou le chef les confirme.
 */
export const PhotoAnalysisStatus = {
  Pending: "pending",
  Running: "running",
  Done: "done",
  Failed: "failed",
  /** Pas analysée : quota épuisé, IA non configurée, analyse automatique coupée */
  Skipped: "skipped",
} as const;
export type PhotoAnalysisStatus =
  (typeof PhotoAnalysisStatus)[keyof typeof PhotoAnalysisStatus];

export type PhotoAiConfidence = "high" | "medium" | "low";

export interface PhotoAiProductResult {
  /** Produit du catalogue de la structure */
  productId: string;
  /** Vu sur le rayon */
  present: boolean;
  /** Nombre de faces visibles (unités de face), si comptable */
  facings: number | null;
  /** Prix lu sur l'étiquette, si lisible */
  price: number | null;
  confidence: PhotoAiConfidence;
}

export interface PhotoAiResult {
  products: PhotoAiProductResult[];
  /** Produits vus mais absents du catalogue (concurrence non répertoriée) */
  others: { name: string; brand: string | null; facings: number | null }[];
  /** Score du rayon sur 100 : présence de nos produits, part de rayon, prix affichés, tenue */
  shelfScore: number;
  /** Remarques courtes de l'IA (rayon mal éclairé, photo floue…) */
  notes: string;
}

export const PHOTO_AI_SKIP_LABELS: Record<string, string> = {
  quota: "Quota mensuel de photos analysées atteint",
  not_configured: "IA photo non configurée",
  disabled: "Analyse automatique désactivée",
  feature: "IA photo absente de la formule",
};

/** Fournisseurs d'IA photo ; l'éditeur choisit celui qui est actif (console). */
export const PhotoAiProviderId = {
  Anthropic: "anthropic",
  Mistral: "mistral",
} as const;
export type PhotoAiProviderId =
  (typeof PhotoAiProviderId)[keyof typeof PhotoAiProviderId];

/** Choix de l'éditeur : un fournisseur, ou « off » (aucune analyse). */
export type PhotoAiProviderChoice = PhotoAiProviderId | "off";

export const PHOTO_AI_PROVIDER_LABELS: Record<PhotoAiProviderChoice, string> = {
  anthropic: "Anthropic (Claude)",
  mistral: "Mistral AI",
  off: "Désactivée",
};
