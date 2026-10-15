/**
 * Tournée : ordre de visite qui raccourcit le trajet, à vol d'oiseau (pas de service de
 * calcul d'itinéraire routier). Plus proche voisin depuis le départ, puis améliorations
 * « 2-opt » (on inverse un tronçon tant que le trajet raccourcit). Parcours ouvert : il ne
 * revient pas au départ.
 */

export interface Point {
  lat: number;
  lng: number;
}

/** Distance à vol d'oiseau en mètres. */
export function haversine(a: Point, b: Point): number {
  const r = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

/** Longueur d'un parcours ouvert : départ puis étapes dans l'ordre. */
export function pathLength(start: Point, stops: Point[]): number {
  let total = 0;
  let from = start;
  for (const s of stops) {
    total += haversine(from, s);
    from = s;
  }
  return total;
}

/** Ordre de visite optimisé des étapes (indices dans `stops`). */
export function optimizeRoute<T extends Point>(start: Point, stops: T[]): T[] {
  // Plus proche voisin.
  const left = [...stops];
  const order: T[] = [];
  let from: Point = start;
  while (left.length) {
    let best = 0;
    for (let i = 1; i < left.length; i++)
      if (haversine(from, left[i]) < haversine(from, left[best])) best = i;
    const [next] = left.splice(best, 1);
    order.push(next);
    from = next;
  }
  // 2-opt : inverser order[i..j] tant que cela raccourcit le trajet.
  const point = (i: number): Point => (i < 0 ? start : order[i]);
  let improved = true;
  for (let pass = 0; improved && pass < 50; pass++) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const before =
          haversine(point(i - 1), order[i]) +
          (j + 1 < order.length ? haversine(order[j], order[j + 1]) : 0);
        const after =
          haversine(point(i - 1), order[j]) +
          (j + 1 < order.length ? haversine(order[i], order[j + 1]) : 0);
        if (after + 0.01 < before) {
          const reversed = order.slice(i, j + 1).reverse();
          order.splice(i, j - i + 1, ...reversed);
          improved = true;
        }
      }
    }
  }
  return order;
}
