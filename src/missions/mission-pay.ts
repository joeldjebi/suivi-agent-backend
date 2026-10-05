import type { MissionPay } from '@suivi/shared';

/** Éléments vides retirés ; paliers du plus haut au plus bas. */
export function normalizePay(pay: MissionPay): MissionPay {
  const out: MissionPay = {};
  if (pay.perForm) out.perForm = pay.perForm;
  if (pay.commissionPercent) out.commissionPercent = pay.commissionPercent;
  if (pay.leadPerTeamForm) out.leadPerTeamForm = pay.leadPerTeamForm;
  if (pay.objectiveBonus?.length)
    out.objectiveBonus = [...pay.objectiveBonus]
      .map((t) => ({ thresholdPercent: t.thresholdPercent, amount: t.amount }))
      .sort((a, b) => b.thresholdPercent - a.thresholdPercent);
  return out;
}
