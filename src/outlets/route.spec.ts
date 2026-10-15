import { haversine, optimizeRoute, pathLength } from './route';

describe('Tournée optimisée', () => {
  const start = { lat: 5.32, lng: -4.02 };
  // Points alignés vers le nord, donnés dans le désordre.
  const at = (m: number, id: string) => ({
    id,
    lat: 5.32 + m / 111_320,
    lng: -4.02,
  });

  it('visite dans l’ordre le plus court, sans revenir au départ', () => {
    const stops = [
      at(900, 'c'),
      at(300, 'a'),
      at(1500, 'e'),
      at(600, 'b'),
      at(1200, 'd'),
    ];
    const route = optimizeRoute(start, stops);
    expect(route.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(Math.abs(pathLength(start, route) - 1500)).toBeLessThan(5);
  });

  it('le 2-opt défait les croisements du plus proche voisin', () => {
    // Carré de 1 km : le plus proche voisin peut croiser son trajet ; l'optimisation non.
    const sq = [
      { id: 'n', lat: 5.329, lng: -4.02 },
      { id: 'ne', lat: 5.329, lng: -4.011 },
      { id: 'e', lat: 5.32, lng: -4.011 },
      { id: 'mid', lat: 5.3245, lng: -4.0155 },
    ];
    const route = optimizeRoute(start, sq);
    const greedyLength = pathLength(start, sq);
    expect(pathLength(start, route)).toBeLessThanOrEqual(greedyLength);
    expect(route).toHaveLength(4);
  });

  it('distance à vol d’oiseau', () => {
    expect(Math.abs(haversine(start, at(1000, 'x')) - 1000)).toBeLessThan(5);
  });
});
