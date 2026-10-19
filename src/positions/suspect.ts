import { haversine } from '../outlets/route';

/** Au-delà, un déplacement terrestre est impossible (≈ 250 km/h). */
export const MAX_SPEED_MS = 70;
/** Sauts courts ignorés (ratés du GPS en ville). */
const MIN_JUMP_M = 1000;
/** Points trop imprécis ignorés : un mauvais relevé n'est pas une fraude. */
const MAX_ACCURACY_M = 100;

export interface TrackPoint {
  lat: number;
  lng: number;
  accuracy: number | null;
  recordedAt: Date;
}

export interface Teleport {
  recordedAt: Date;
  distanceM: number;
  seconds: number;
}

/**
 * Déplacements impossibles dans une suite de points (triés par heure), à partir du dernier
 * point déjà connu : signe d'une application de fausse position.
 */
export function findTeleports(
  previous: TrackPoint | null,
  points: TrackPoint[],
): Teleport[] {
  const precise = (p: TrackPoint) =>
    p.accuracy === null || p.accuracy <= MAX_ACCURACY_M;
  const result: Teleport[] = [];
  let last = previous && precise(previous) ? previous : null;
  for (const p of [...points].sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
  )) {
    if (!precise(p)) continue;
    if (last) {
      const distanceM = haversine(last, p);
      const seconds = Math.max(
        1,
        (p.recordedAt.getTime() - last.recordedAt.getTime()) / 1000,
      );
      if (distanceM >= MIN_JUMP_M && distanceM / seconds > MAX_SPEED_MS)
        result.push({
          recordedAt: p.recordedAt,
          distanceM: Math.round(distanceM),
          seconds: Math.round(seconds),
        });
    }
    last = p;
  }
  return result;
}
