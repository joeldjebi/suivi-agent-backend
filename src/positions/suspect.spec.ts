import { findTeleports } from './suspect';

const at = (s: number) => new Date(Date.UTC(2026, 9, 19, 8, 0, s));
const p = (
  lat: number,
  lng: number,
  s: number,
  accuracy: number | null = 10,
) => ({
  lat,
  lng,
  accuracy,
  recordedAt: at(s),
});

describe('Positions suspectes', () => {
  it('repère un déplacement impossible, pas une marche ni un trajet en voiture', () => {
    // Plateau → Cocody (≈ 6 km) en 30 s : impossible.
    expect(findTeleports(p(5.3245, -4.0205, 0), [p(5.36, -3.98, 30)])).toEqual([
      { recordedAt: at(30), distanceM: expect.any(Number), seconds: 30 },
    ]);
    // 6 km en 10 min (36 km/h) : normal.
    expect(findTeleports(p(5.3245, -4.0205, 0), [p(5.36, -3.98, 600)])).toEqual(
      [],
    );
    // Petit saut du GPS en ville : ignoré.
    expect(
      findTeleports(p(5.3245, -4.0205, 0), [p(5.3285, -4.0205, 2)]),
    ).toEqual([]);
  });

  it('ignore les relevés imprécis et compare au dernier point fiable', () => {
    expect(
      findTeleports(null, [
        p(5.3245, -4.0205, 0),
        p(5.36, -3.98, 20, 2500),
        p(5.3246, -4.0205, 40),
      ]),
    ).toEqual([]);
  });
});
