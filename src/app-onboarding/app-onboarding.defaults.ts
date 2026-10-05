import { OnboardingAnimation } from '@suivi/shared';

/** Pages d'origine de l'onboarding (réinstallables depuis la console). */
export const DEFAULT_SLIDES: {
  title: string;
  body: string;
  animation: OnboardingAnimation;
}[] = [
  {
    title: 'Votre journée, en un geste',
    body: 'Démarrez votre journée dans votre zone : votre position est partagée avec votre équipe pendant le travail, jamais en dehors.',
    animation: OnboardingAnimation.Location,
  },
  {
    title: 'Vos missions sur le terrain',
    body: 'Consultez vos objectifs, remplissez vos formulaires même sans réseau et suivez votre progression en direct.',
    animation: OnboardingAnimation.Missions,
  },
  {
    title: 'Toute l’équipe, en temps réel',
    body: 'Votre chef d’équipe vous accompagne : zones, alertes et messages arrivent aussitôt sur votre téléphone.',
    animation: OnboardingAnimation.Team,
  },
];
