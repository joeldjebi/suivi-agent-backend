import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../common/db.service';
import { CITIES, circle, type Area } from '../setup/setup.catalog';

export interface Place {
  /** Identifiant stable du résultat (catalogue ou OpenStreetMap) */
  id: string;
  name: string;
  /** « Commune · Abidjan », « Quartier », « Marché »… */
  detail: string;
  source: 'catalog' | 'osm';
  area: Area;
  /** Une partie déjà couverte par d'autres zones a été retirée */
  trimmed: boolean;
  /** Zones existantes qui chevauchaient le lieu */
  overlaps: string[];
}

interface Candidate {
  id: string;
  name: string;
  detail: string;
  source: Place['source'];
  geojson: unknown;
}

interface NominatimResult {
  place_id: number;
  name?: string;
  display_name: string;
  type?: string;
  addresstype?: string;
  lat: string;
  lon: string;
  geojson?: { type: string };
}

const TYPES: Record<string, string> = {
  city: 'Ville',
  town: 'Ville',
  village: 'Village',
  suburb: 'Quartier',
  quarter: 'Quartier',
  neighbourhood: 'Quartier',
  city_district: 'Commune',
  municipality: 'Commune',
  administrative: 'Commune',
  marketplace: 'Marché',
  industrial: 'Zone industrielle',
  residential: 'Zone résidentielle',
};

/** Sans accents ni majuscules, pour comparer les noms. */
const plain = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Recherche d'un lieu par son nom pour créer une zone : communes du catalogue, puis
 * OpenStreetMap (Nominatim) pour tout lieu de Côte d'Ivoire, avec son contour s'il existe
 * (sinon un cercle de 800 m). Les parties déjà couvertes par une zone active sont
 * retirées, pour que la zone puisse être créée telle quelle.
 */
@Injectable()
export class PlacesService {
  private readonly logger = new Logger(PlacesService.name);
  private readonly cache = new Map<
    string,
    { at: number; items: Candidate[] }
  >();

  constructor(private readonly db: DbService) {}

  async search(q: string): Promise<Place[]> {
    const query = q.trim();
    if (query.length < 2) return [];
    const needle = plain(query);
    const catalog: Candidate[] = CITIES.flatMap((c) =>
      c.areas
        .filter(
          (a) =>
            plain(a.name).includes(needle) || plain(c.name).includes(needle),
        )
        .map((a) => ({
          id: `catalog:${a.key}`,
          name: a.name,
          detail: c.key === 'abidjan' ? 'Commune · Abidjan' : 'Centre-ville',
          source: 'catalog' as const,
          geojson: a.area,
        })),
    ).slice(0, 5);
    const osm = query.length >= 3 ? await this.osm(query) : [];
    // Un seul résultat par nom (OpenStreetMap a souvent « Riviera 3 » et « Riviéra 3 »).
    const seen = new Set<string>();
    const candidates = [...catalog, ...osm]
      .filter((c) => !seen.has(plain(c.name)) && seen.add(plain(c.name)))
      .slice(0, 8);
    const places: Place[] = [];
    for (const c of candidates) {
      const place = await this.prepare(c);
      if (place) places.push(place);
    }
    return places;
  }

  /** OpenStreetMap : 6 résultats au plus en Côte d'Ivoire, gardés 1 h en mémoire. */
  private async osm(query: string): Promise<Candidate[]> {
    if (process.env.GEOCODER === 'off') return [];
    const key = plain(query);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 3600_000) return hit.items;
    try {
      const url = new URL('https://nominatim.openstreetmap.org/search');
      url.search = new URLSearchParams({
        q: query,
        countrycodes: 'ci',
        format: 'jsonv2',
        polygon_geojson: '1',
        limit: '6',
        'accept-language': 'fr',
      }).toString();
      const res = await fetch(url, {
        headers: { 'User-Agent': 'SuiviAgent/1.0 (recherche de zones)' },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as NominatimResult[];
      const items = rows.map((r) => {
        const polygon =
          r.geojson?.type === 'Polygon' || r.geojson?.type === 'MultiPolygon';
        const place = r.display_name.split(',').slice(1, 3).join(',').trim();
        return {
          id: `osm:${r.place_id}`,
          name: r.name || r.display_name.split(',')[0],
          detail: [TYPES[r.addresstype ?? r.type ?? ''] ?? 'Lieu', place]
            .filter(Boolean)
            .join(' · '),
          source: 'osm' as const,
          // Lieu sans contour : 800 m autour du point.
          geojson: polygon
            ? r.geojson
            : circle(Number(r.lat), Number(r.lon), 800),
        };
      });
      this.cache.set(key, { at: Date.now(), items });
      if (this.cache.size > 500) this.cache.clear();
      return items;
    } catch (error) {
      this.logger.warn(
        `Recherche OpenStreetMap indisponible : ${(error as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Contour simplifié (≈ 10 m), en un seul morceau (le plus grand), sans les parties déjà
   * couvertes par les zones actives de la structure.
   */
  private async prepare(c: Candidate): Promise<Place | null> {
    const [row] = await this.db.manager.query<
      { geojson: string | null; trimmed: boolean; overlaps: string[] | null }[]
    >(
      `WITH src AS (
         SELECT ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($1), 4326)) AS g
       ),
       simple AS (
         SELECT ST_CollectionExtract(ST_MakeValid(ST_SimplifyPreserveTopology(g, 0.0001)), 3) AS g FROM src
       ),
       others AS (
         SELECT array_agg(z.name ORDER BY z.name) AS names, ST_Union(z.area) AS g
         FROM zones z, simple s
         WHERE z.is_active AND ST_Intersects(z.area, s.g) AND NOT ST_Touches(z.area, s.g)
       ),
       cut AS (
         SELECT CASE WHEN o.g IS NULL THEN s.g
                     ELSE ST_CollectionExtract(ST_MakeValid(ST_Difference(s.g, o.g)), 3) END AS g,
                s.g AS original, o.names
         FROM simple s, others o
       ),
       biggest AS (
         SELECT d.geom AS g, c.original, c.names
         FROM cut c, LATERAL ST_Dump(c.g) d
         ORDER BY ST_Area(d.geom) DESC LIMIT 1
       )
       SELECT ST_AsGeoJSON(g, 6) AS geojson,
              ST_Area(g) < ST_Area(original) * 0.99 AS trimmed,
              names AS overlaps
       FROM biggest
       WHERE ST_Area(g) > 1e-8`,
      [JSON.stringify(c.geojson)],
    );
    if (!row?.geojson) return null;
    const area = JSON.parse(row.geojson) as Area;
    if (area.type !== 'Polygon') return null;
    return {
      id: c.id,
      name: c.name,
      detail: c.detail,
      source: c.source,
      area,
      trimmed: row.trimmed,
      overlaps: row.overlaps ?? [],
    };
  }
}
