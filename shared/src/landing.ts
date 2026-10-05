/**
 * Contenu du site vitrine, modifiable par l'éditeur depuis sa console : textes, ordre et
 * visibilité des sections, images. Les formules sont lues en direct dans le catalogue.
 */

/** Action d'un bouton : inscription (essai gratuit), demande de démo, connexion, ou lien. */
export type LandingAction = 'signup' | 'demo' | 'login' | 'link';

export interface LandingCta {
  label: string;
  action: LandingAction;
  /** Adresse, si l'action est un lien */
  href?: string;
}

/** Illustration animée fournie par le site, ou image envoyée par l'éditeur. */
export type LandingVisual = 'map' | 'phone' | 'dashboard' | 'payroll' | 'missions' | 'image';

export interface LandingItem {
  title: string;
  text: string;
  /** Nom d'icône (lucide) pour les cartes */
  icon?: string;
}

interface SectionBase {
  /** Identifiant stable (ancre de navigation) */
  id: string;
  enabled: boolean;
  /** Libellé dans le menu du site ; absent : pas dans le menu */
  navLabel?: string;
}

export interface StatsSection extends SectionBase {
  type: 'stats';
  items: { value: string; label: string }[];
}

/** Fonctionnalité mise en scène : texte d'un côté, illustration animée de l'autre. */
export interface FeatureSection extends SectionBase {
  type: 'feature';
  eyebrow: string;
  title: string;
  text: string;
  bullets: string[];
  visual: LandingVisual;
  imageId?: string | null;
  /** Côté de l'illustration */
  layout: 'left' | 'right';
  /** Fond sombre, pleine largeur */
  dark?: boolean;
}

/** Profils : agents, chefs d'équipe, administrateurs. */
export interface AudiencesSection extends SectionBase {
  type: 'audiences';
  eyebrow: string;
  title: string;
  items: LandingItem[];
}

/** Récit au défilement : un téléphone fixe dont l'écran change avec chaque étape. */
export interface StorySection extends SectionBase {
  type: 'story';
  eyebrow: string;
  title: string;
  steps: LandingItem[];
}

export interface PricingSection extends SectionBase {
  type: 'pricing';
  eyebrow: string;
  title: string;
  subtitle: string;
}

export interface TestimonialsSection extends SectionBase {
  type: 'testimonials';
  title: string;
  items: { quote: string; author: string; role: string }[];
}

export interface FaqSection extends SectionBase {
  type: 'faq';
  title: string;
  items: { question: string; answer: string }[];
}

export interface CtaSection extends SectionBase {
  type: 'cta';
  title: string;
  text: string;
  primary: LandingCta;
  secondary?: LandingCta | null;
}

/** Grande phrase dont les mots s'éclairent au fil du défilement. */
export interface StatementSection extends SectionBase {
  type: 'statement';
  text: string;
  /** Fin de phrase mise en couleur */
  emphasis: string;
}

/** Illustrations des tuiles bento : petites scènes animées du produit. */
export type BentoVisual =
  | 'map'
  | 'offline'
  | 'payroll'
  | 'missions'
  | 'security'
  | 'devices'
  | 'alerts'
  | 'chart';

export interface BentoTile {
  title: string;
  text: string;
  visual: BentoVisual;
  /** Taille dans la grille : grande (2×2), large (2×1), haute (1×2), petite (1×1) */
  size: 'large' | 'wide' | 'tall' | 'small';
}

/** Grille de tuiles de tailles variées, chacune avec sa scène animée. */
export interface BentoSection extends SectionBase {
  type: 'bento';
  eyebrow: string;
  title: string;
  tiles: BentoTile[];
}

export type LandingSection =
  | StatementSection
  | BentoSection
  | StatsSection
  | FeatureSection
  | AudiencesSection
  | StorySection
  | PricingSection
  | TestimonialsSection
  | FaqSection
  | CtaSection;

export type LandingSectionType = LandingSection['type'];

export interface LandingContent {
  /** Version du format (évolutions futures) */
  version: 1;
  brand: { name: string; tagline: string };
  seo: { title: string; description: string };
  hero: {
    eyebrow: string;
    title: string;
    subtitle: string;
    primary: LandingCta;
    secondary?: LandingCta | null;
    visual: LandingVisual;
    imageId?: string | null;
  };
  sections: LandingSection[];
  footer: {
    text: string;
    email: string;
    phone: string;
    address: string;
  };
}

/** Plan public du site : formule proposée, telle que le catalogue la décrit. */
export interface LandingPlan {
  code: string;
  name: string;
  description: string;
  monthlyPrice: number;
  includedAgents: number;
  includedLeads: number;
  extraAgentPrice: number;
  features: string[];
}

export interface PublicLanding {
  content: LandingContent;
  plans: LandingPlan[];
  currency: string;
  trialDays: number;
  annualDiscountPercent: number;
}

export const DemoRequestStatus = {
  New: 'new',
  Contacted: 'contacted',
  Won: 'won',
  Lost: 'lost',
} as const;
export type DemoRequestStatus = (typeof DemoRequestStatus)[keyof typeof DemoRequestStatus];
