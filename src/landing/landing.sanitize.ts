import type {
  BentoTile,
  BentoVisual,
  LandingAction,
  LandingContent,
  LandingCta,
  LandingItem,
  LandingSection,
  LandingVisual,
} from '@suivi/shared';
import { badRequest } from '../common/business.exception';

/**
 * Contenu du site reçu de la console : seuls les champs connus sont gardés, avec des
 * longueurs bornées. Le texte est affiché tel quel (jamais interprété comme du HTML).
 */
const ACTIONS: LandingAction[] = ['signup', 'demo', 'login', 'link'];
const VISUALS: LandingVisual[] = [
  'map',
  'phone',
  'dashboard',
  'payroll',
  'missions',
  'image',
];
const BENTO_VISUALS: BentoVisual[] = [
  'map',
  'offline',
  'payroll',
  'missions',
  'security',
  'devices',
  'alerts',
  'chart',
];
const BENTO_SIZES: BentoTile['size'][] = ['large', 'wide', 'tall', 'small'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9-]{1,40}$/;

type Raw = Record<string, unknown>;

const fail = (path: string, message: string) =>
  badRequest('INVALID_LANDING', `${path} : ${message}`);

function obj(value: unknown, path: string): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail(path, 'objet attendu');
  return value as Raw;
}

function str(
  value: unknown,
  path: string,
  max: number,
  required = true,
): string {
  if (value === undefined || value === null) {
    if (required) throw fail(path, 'texte requis');
    return '';
  }
  if (typeof value !== 'string') throw fail(path, 'texte attendu');
  const text = value.trim();
  if (required && !text) throw fail(path, 'texte requis');
  if (text.length > max) throw fail(path, `${max} caractères au maximum`);
  return text;
}

function list<T>(
  value: unknown,
  path: string,
  max: number,
  map: (item: unknown, path: string) => T,
): T[] {
  if (!Array.isArray(value)) throw fail(path, 'liste attendue');
  if (value.length > max) throw fail(path, `${max} éléments au maximum`);
  return value.map((item, i) => map(item, `${path}[${i}]`));
}

function cta(value: unknown, path: string): LandingCta {
  const raw = obj(value, path);
  const action = raw.action as LandingAction;
  if (!ACTIONS.includes(action))
    throw fail(`${path}.action`, 'action inconnue');
  const result: LandingCta = {
    label: str(raw.label, `${path}.label`, 40),
    action,
  };
  if (action === 'link') {
    const href = str(raw.href, `${path}.href`, 300);
    // Liens externes en https, ancres ou chemins du site seulement.
    if (!/^(https:\/\/|#|\/)/.test(href))
      throw fail(`${path}.href`, 'lien https, ancre ou chemin');
    result.href = href;
  }
  return result;
}

const optionalCta = (value: unknown, path: string) =>
  value === undefined || value === null ? null : cta(value, path);

function imageId(value: unknown, path: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID.test(value))
    throw fail(path, 'image inconnue');
  return value;
}

function visual(value: unknown, path: string): LandingVisual {
  if (!VISUALS.includes(value as LandingVisual))
    throw fail(path, 'illustration inconnue');
  return value as LandingVisual;
}

const item = (value: unknown, path: string): LandingItem => {
  const raw = obj(value, path);
  return {
    title: str(raw.title, `${path}.title`, 80),
    text: str(raw.text, `${path}.text`, 400),
    ...(raw.icon ? { icon: str(raw.icon, `${path}.icon`, 40) } : {}),
  };
};

function section(value: unknown, path: string): LandingSection {
  const raw = obj(value, path);
  const id = str(raw.id, `${path}.id`, 40);
  if (!SLUG.test(id))
    throw fail(`${path}.id`, 'minuscules, chiffres et tirets');
  const base = {
    id,
    enabled: raw.enabled !== false,
    ...(raw.navLabel
      ? { navLabel: str(raw.navLabel, `${path}.navLabel`, 24) }
      : {}),
  };
  switch (raw.type) {
    case 'statement':
      return {
        ...base,
        type: 'statement',
        text: str(raw.text, `${path}.text`, 240),
        emphasis: str(raw.emphasis, `${path}.emphasis`, 120, false),
      };
    case 'bento':
      return {
        ...base,
        type: 'bento',
        eyebrow: str(raw.eyebrow, `${path}.eyebrow`, 60, false),
        title: str(raw.title, `${path}.title`, 120),
        tiles: list(raw.tiles, `${path}.tiles`, 8, (v, p) => {
          const r = obj(v, p);
          if (!BENTO_VISUALS.includes(r.visual as BentoVisual))
            throw fail(`${p}.visual`, 'illustration inconnue');
          if (!BENTO_SIZES.includes(r.size as BentoTile['size']))
            throw fail(`${p}.size`, 'taille inconnue');
          return {
            title: str(r.title, `${p}.title`, 60),
            text: str(r.text, `${p}.text`, 200),
            visual: r.visual as BentoVisual,
            size: r.size as BentoTile['size'],
          };
        }),
      };
    case 'stats':
      return {
        ...base,
        type: 'stats',
        items: list(raw.items, `${path}.items`, 6, (v, p) => {
          const r = obj(v, p);
          return {
            value: str(r.value, `${p}.value`, 12),
            label: str(r.label, `${p}.label`, 80),
          };
        }),
      };
    case 'feature':
      return {
        ...base,
        type: 'feature',
        eyebrow: str(raw.eyebrow, `${path}.eyebrow`, 60, false),
        title: str(raw.title, `${path}.title`, 120),
        text: str(raw.text, `${path}.text`, 600),
        bullets: list(raw.bullets ?? [], `${path}.bullets`, 6, (v, p) =>
          str(v, p, 160),
        ),
        visual: visual(raw.visual, `${path}.visual`),
        imageId: imageId(raw.imageId, `${path}.imageId`),
        layout: raw.layout === 'left' ? 'left' : 'right',
        dark: raw.dark === true,
      };
    case 'audiences':
      return {
        ...base,
        type: 'audiences',
        eyebrow: str(raw.eyebrow, `${path}.eyebrow`, 60, false),
        title: str(raw.title, `${path}.title`, 120),
        items: list(raw.items, `${path}.items`, 6, item),
      };
    case 'story':
      return {
        ...base,
        type: 'story',
        eyebrow: str(raw.eyebrow, `${path}.eyebrow`, 60, false),
        title: str(raw.title, `${path}.title`, 120),
        steps: list(raw.steps, `${path}.steps`, 6, item),
      };
    case 'pricing':
      return {
        ...base,
        type: 'pricing',
        eyebrow: str(raw.eyebrow, `${path}.eyebrow`, 60, false),
        title: str(raw.title, `${path}.title`, 120),
        subtitle: str(raw.subtitle, `${path}.subtitle`, 300, false),
      };
    case 'testimonials':
      return {
        ...base,
        type: 'testimonials',
        title: str(raw.title, `${path}.title`, 120),
        items: list(raw.items, `${path}.items`, 9, (v, p) => {
          const r = obj(v, p);
          return {
            quote: str(r.quote, `${p}.quote`, 400),
            author: str(r.author, `${p}.author`, 60),
            role: str(r.role, `${p}.role`, 80, false),
          };
        }),
      };
    case 'faq':
      return {
        ...base,
        type: 'faq',
        title: str(raw.title, `${path}.title`, 120),
        items: list(raw.items, `${path}.items`, 20, (v, p) => {
          const r = obj(v, p);
          return {
            question: str(r.question, `${p}.question`, 160),
            answer: str(r.answer, `${p}.answer`, 800),
          };
        }),
      };
    case 'cta':
      return {
        ...base,
        type: 'cta',
        title: str(raw.title, `${path}.title`, 120),
        text: str(raw.text, `${path}.text`, 300, false),
        primary: cta(raw.primary, `${path}.primary`),
        secondary: optionalCta(raw.secondary, `${path}.secondary`),
      };
    default:
      throw fail(`${path}.type`, 'type de section inconnu');
  }
}

export function sanitizeLanding(input: unknown): LandingContent {
  const raw = obj(input, 'contenu');
  const brand = obj(raw.brand, 'brand');
  const seo = obj(raw.seo, 'seo');
  const hero = obj(raw.hero, 'hero');
  const footer = obj(raw.footer, 'footer');
  const sections = list(raw.sections, 'sections', 20, section);
  const ids = new Set<string>();
  for (const s of sections) {
    if (ids.has(s.id))
      throw fail('sections', `identifiant « ${s.id} » en double`);
    ids.add(s.id);
  }
  return {
    version: 1,
    brand: {
      name: str(brand.name, 'brand.name', 40),
      tagline: str(brand.tagline, 'brand.tagline', 120, false),
    },
    seo: {
      title: str(seo.title, 'seo.title', 70),
      description: str(seo.description, 'seo.description', 170),
    },
    hero: {
      eyebrow: str(hero.eyebrow, 'hero.eyebrow', 60, false),
      title: str(hero.title, 'hero.title', 100),
      subtitle: str(hero.subtitle, 'hero.subtitle', 300),
      primary: cta(hero.primary, 'hero.primary'),
      secondary: optionalCta(hero.secondary, 'hero.secondary'),
      visual: visual(hero.visual, 'hero.visual'),
      imageId: imageId(hero.imageId, 'hero.imageId'),
    },
    sections,
    footer: {
      text: str(footer.text, 'footer.text', 200, false),
      email: str(footer.email, 'footer.email', 120, false),
      phone: str(footer.phone, 'footer.phone', 30, false),
      address: str(footer.address, 'footer.address', 120, false),
    },
  };
}
