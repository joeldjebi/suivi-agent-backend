/** Guide « Bien démarrer » de l'administrateur d'une structure. */
export const OnboardingStep = {
  /** Lire et préparer les prérequis (coché à la main) */
  Prerequisites: 'prerequisites',
  /** Fuseau, horaires et jours travaillés vérifiés (coché à la main) */
  Settings: 'settings',
  Zones: 'zones',
  /** Groupes ou chefs d'équipe, selon la formule */
  Teams: 'teams',
  Agents: 'agents',
  /** Un agent au moins s'est connecté à l'application */
  App: 'app',
  /** Formulaires de terrain (formule avec missions) */
  Missions: 'missions',
  /** Règles de rémunération (formule avec la paie) */
  Payroll: 'payroll',
  /** Une première journée de travail démarrée */
  FirstDay: 'first_day',
} as const;
export type OnboardingStep = (typeof OnboardingStep)[keyof typeof OnboardingStep];

export interface OnboardingStepState {
  key: OnboardingStep;
  done: boolean;
  /** Validée à la main par l'administrateur, sinon d'après les données */
  manual: boolean;
}

export interface OnboardingState {
  steps: OnboardingStepState[];
  /** Guide masqué par l'administrateur */
  dismissed: boolean;
  completed: boolean;
}
