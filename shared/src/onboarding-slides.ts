/** Onboarding de l'app mobile (avant la connexion), réglé par l'éditeur. */
export const OnboardingAnimation = {
  /** Position partagée pendant la journée */
  Location: 'location',
  /** Missions et formulaires */
  Missions: 'missions',
  /** Équipe et temps réel */
  Team: 'team',
} as const;
export type OnboardingAnimation = (typeof OnboardingAnimation)[keyof typeof OnboardingAnimation];

export interface AppOnboardingSlide {
  id: string;
  title: string;
  body: string;
  /** Animation fournie avec l'app, utilisée sans animation importée */
  animation: OnboardingAnimation;
  /** Couleur d'accent (#RRGGBB) ; vide : couleur de l'app */
  color: string | null;
  /** Animation Lottie importée par l'éditeur (adresse relative) */
  lottieUrl: string | null;
}

/** Contenu lu par l'app, sans connexion. */
export interface AppOnboarding {
  enabled: boolean;
  /** Augmente quand l'éditeur republie : l'app remontre l'onboarding une fois */
  version: number;
  slides: AppOnboardingSlide[];
}

/** Vue de la console éditeur. */
export interface AppOnboardingEditorSlide extends AppOnboardingSlide {
  position: number;
  isActive: boolean;
  lottieName: string | null;
  lottieSize: number | null;
  updatedAt: string;
}

export interface AppOnboardingEditor {
  enabled: boolean;
  version: number;
  publishedAt: string | null;
  slides: AppOnboardingEditorSlide[];
}
