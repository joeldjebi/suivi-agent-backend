import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  PHOTO_AI_PROVIDER_LABELS,
  PhotoAiProviderId,
  type PhotoAiResult,
} from '@suivi/shared';
import { z } from 'zod';

/** Produit du catalogue donné à l'IA. */
export interface CatalogItem {
  id: string;
  name: string;
  brand: string | null;
  format: string | null;
  category: string | null;
  /** Produit de la structure ; false : concurrent */
  own: boolean;
}

/** Photo de référence d'un produit du catalogue (aide l'IA à le reconnaître). */
export interface ReferenceImage {
  productId: string;
  image: Buffer;
  mime: string;
}

export interface AnalysisInput {
  image: Buffer;
  mime: string;
  catalog: CatalogItem[];
  references?: ReferenceImage[];
}

export interface AnalysisOutput {
  result: PhotoAiResult;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Coût de l'appel, en dollars US */
  costUsd: number;
}

/** Fournisseur d'analyse d'images ; « fake » sert aux tests et aux démonstrations. */
export interface PhotoAiProvider {
  readonly name: string;
  /** Modèle utilisé, affiché dans la console */
  readonly model: string;
  analyze(input: AnalysisInput): Promise<AnalysisOutput>;
}

export const PHOTO_AI_PROVIDER = Symbol('PHOTO_AI_PROVIDER');

/** Erreur définitive (photo illisible, refus) : inutile de réessayer. */
export class PermanentAnalysisError extends Error {}

// ------------------------------------------------------------ commun

/** Réponse attendue de l'IA : les produits par leur code court (P1, P2…). */
const ShelfSchema = z.object({
  products: z.array(
    z.object({
      ref: z.string().describe('Code du produit dans le catalogue (P1, P2…)'),
      present: z.boolean(),
      facings: z
        .number()
        .int()
        .nullable()
        .describe('Nombre de faces visibles ; null si impossible à compter'),
      price: z
        .number()
        .nullable()
        .describe(
          'Prix unitaire lu sur l’étiquette, en francs CFA ; null si illisible',
        ),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
  others: z.array(
    z.object({
      name: z.string(),
      brand: z.string().nullable(),
      facings: z.number().int().nullable(),
    }),
  ),
  shelfScore: z.number().int().describe('Score du rayon de 0 à 100'),
  notes: z.string(),
});
type Shelf = z.infer<typeof ShelfSchema>;

const SYSTEM = `Tu analyses des photos de rayons de commerces (boutiques, supérettes, maquis, dépôts) prises par des commerciaux terrain en Afrique de l'Ouest francophone.
Pour chaque produit du catalogue fourni, indique s'il est visible sur la photo, compte ses faces (unités tournées vers le client, au premier rang) et lis son prix sur l'étiquette s'il est lisible (en francs CFA, prix d'une unité).
Ne conclus « présent » que si tu reconnais le produit (marque, format, couleur, forme). Un produit de même marque mais d'un autre format est un autre produit. En cas de doute, mets « present » à false avec une confiance « low ».
Des photos de référence de certains produits peuvent précéder la photo du rayon : elles montrent le produit seul, pas le rayon. N'analyse que la dernière photo.
Liste aussi, dans « others », les produits visibles qui ne sont pas dans le catalogue (au plus 10, les plus visibles).
« shelfScore » (0 à 100) mesure l'exécution en magasin des produits marqués « nos produits » : présence de la gamme, part de rayon face aux concurrents, prix affichés, rayon propre et bien rangé. Une photo inexploitable (floue, sombre, sans rayon) a un score de 0 et l'explique dans « notes ».
« notes » : une ou deux phrases en français, utiles à un responsable commercial ; nomme les produits par leur nom, jamais par leur code (P1, P2…).`;

/** Catalogue en codes courts (P1, P2…) : l'IA ne manipule pas les identifiants. */
function catalogPrompt(input: AnalysisInput) {
  const refs = input.catalog.map((p, i) => ({ ref: `P${i + 1}`, product: p }));
  const text = refs
    .map(
      ({ ref, product: p }) =>
        `${ref} · ${p.name}${p.brand ? ` · marque ${p.brand}` : ''}${p.format ? ` · ${p.format}` : ''}${p.category ? ` · ${p.category}` : ''} · ${p.own ? 'notre produit' : 'concurrent'}`,
    )
    .join('\n');
  const refOf = new Map(refs.map((r) => [r.product.id, r.ref]));
  const references = (input.references ?? []).flatMap((r) => {
    const ref = refOf.get(r.productId);
    return ref ? [{ ...r, ref }] : [];
  });
  return {
    refs,
    references,
    question: `Catalogue (code · produit) :\n${text}\n\nAnalyse ce rayon : un résultat par produit du catalogue.`,
  };
}

/** Réponse de l'IA → résultat : codes retraduits, valeurs bornées. */
function toResult(
  parsed: Shelf,
  refs: { ref: string; product: CatalogItem }[],
): PhotoAiResult {
  const byRef = new Map(refs.map((r) => [r.ref, r.product.id]));
  const seen = new Set<string>();
  const products = parsed.products.flatMap((p) => {
    const productId = byRef.get(p.ref);
    // Un code inconnu ou répété est ignoré : l'IA ne peut pas inventer de produit.
    if (!productId || seen.has(productId)) return [];
    seen.add(productId);
    return [
      {
        productId,
        present: p.present,
        facings: p.facings == null ? null : Math.max(0, p.facings),
        price: p.price == null || p.price <= 0 ? null : p.price,
        confidence: p.confidence,
      },
    ];
  });
  return {
    products,
    others: parsed.others.slice(0, 10),
    shelfScore: Math.min(100, Math.max(0, parsed.shelfScore)),
    notes: parsed.notes,
  };
}

const price = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);

// ------------------------------------------------------------ Claude

export class ClaudeProvider implements PhotoAiProvider {
  readonly name = PhotoAiProviderId.Anthropic;
  private readonly client = new Anthropic();
  readonly model = process.env.PHOTO_AI_MODEL || 'claude-opus-5-5';
  private readonly effort = (process.env.PHOTO_AI_EFFORT || 'medium') as
    'low' | 'medium' | 'high';
  /** Prix par million de jetons (entrée, sortie) ; réglables si le modèle change. */
  private readonly priceIn = price('PHOTO_AI_PRICE_IN_PER_MTOK', 4);
  private readonly priceOut = price('PHOTO_AI_PRICE_OUT_PER_MTOK', 20);

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const { refs, references, question } = catalogPrompt(input);
    const image = (data: Buffer, mime: string) =>
      ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mime as 'image/jpeg' | 'image/png' | 'image/webp',
          data: data.toString('base64'),
        },
      }) as const;
    const response = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      // Refus de sécurité : un autre modèle reprend la même demande.
      fallbacks: 'default',
      output_config: {
        effort: this.effort,
        format: zodOutputFormat(ShelfSchema),
      },
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            ...references.flatMap((r) => [
              {
                type: 'text' as const,
                text: `Photo de référence de ${r.ref} :`,
              },
              image(r.image, r.mime),
            ]),
            { type: 'text', text: 'Photo du rayon à analyser :' },
            image(input.image, input.mime),
            { type: 'text', text: question },
          ],
        },
      ],
    });
    if (response.stop_reason === 'refusal')
      throw new PermanentAnalysisError('Analyse refusée par le modèle');
    if (response.stop_reason === 'max_tokens' || !response.parsed_output)
      throw new Error('Réponse incomplète du modèle');
    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    return {
      result: toResult(response.parsed_output, refs),
      model: response.model,
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens * this.priceIn + outputTokens * this.priceOut) / 1_000_000,
    };
  }
}

// ------------------------------------------------------------ Mistral

/** Schéma JSON du résultat pour Mistral (sortie stricte) : sans les bornes techniques de Zod. */
function strictSchema(): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => !['$schema', 'minimum', 'maximum'].includes(k))
          .map(([k, x]) => [k, clean(x)]),
      );
    return v;
  };
  return clean(z.toJSONSchema(ShelfSchema, { target: 'draft-7' })) as Record<
    string,
    unknown
  >;
}

interface MistralResponse {
  model: string;
  choices: {
    finish_reason: string;
    message: { content: string | { type: string; text?: string }[] | null };
  }[];
  usage: { prompt_tokens: number; completion_tokens: number };
}

/**
 * Mistral AI (modèle de vision, sortie JSON stricte) par son API HTTP. Clé : MISTRAL_API_KEY.
 */
export class MistralProvider implements PhotoAiProvider {
  readonly name = PhotoAiProviderId.Mistral;
  readonly model = process.env.MISTRAL_PHOTO_AI_MODEL || 'mistral-large-4';
  private readonly url =
    process.env.MISTRAL_API_URL || 'https://api.mistral.ai/v1/chat/completions';
  private readonly priceIn = price('MISTRAL_PRICE_IN_PER_MTOK', 0.7);
  private readonly priceOut = price('MISTRAL_PRICE_OUT_PER_MTOK', 2.1);
  private readonly schema = strictSchema();

  constructor(private readonly apiKey = process.env.MISTRAL_API_KEY ?? '') {}

  async analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    const { refs, references, question } = catalogPrompt(input);
    const image = (data: Buffer, mime: string) => ({
      type: 'image_url',
      image_url: `data:${mime};base64,${data.toString('base64')}`,
    });
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        // Réponse la plus probable : Mistral exige alors top_p = 1.
        temperature: 0,
        top_p: 1,
        max_tokens: 16000,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'rayon', schema: this.schema, strict: true },
        },
        messages: [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: [
              ...references.flatMap((r) => [
                { type: 'text', text: `Photo de référence de ${r.ref} :` },
                image(r.image, r.mime),
              ]),
              { type: 'text', text: 'Photo du rayon à analyser :' },
              image(input.image, input.mime),
              { type: 'text', text: question },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const message = `Mistral AI : erreur ${res.status}${detail ? ` (${detail})` : ''}`;
      // Requête refusée telle quelle (image, format) : la refaire ne changerait rien.
      if (res.status === 400 || res.status === 422)
        throw new PermanentAnalysisError(message);
      throw new Error(message);
    }
    const data = (await res.json()) as MistralResponse;
    const choice = data.choices?.[0];
    if (!choice || choice.finish_reason === 'length')
      throw new Error('Réponse incomplète du modèle');
    const content = choice.message.content;
    const text =
      typeof content === 'string'
        ? content
        : (content ?? []).map((c) => c.text ?? '').join('');
    let parsed: Shelf;
    try {
      parsed = ShelfSchema.parse(JSON.parse(text));
    } catch {
      throw new Error('Réponse du modèle illisible');
    }
    const inputTokens = data.usage?.prompt_tokens ?? 0;
    const outputTokens = data.usage?.completion_tokens ?? 0;
    return {
      result: toResult(parsed, refs),
      model: data.model || this.model,
      inputTokens,
      outputTokens,
      costUsd:
        (inputTokens * this.priceIn + outputTokens * this.priceOut) / 1_000_000,
    };
  }
}

// ------------------------------------------------------------ simulée

/**
 * IA simulée (tests, démonstrations sans frais) : nos produits présents avec 4 faces, les
 * concurrents absents, un score de 80. Les tests règlent `next` (résultat) ou `fail`.
 */
export class FakeProvider implements PhotoAiProvider {
  readonly name = 'fake';
  readonly model = 'fake';
  /** Dernière demande reçue (les tests y lisent les photos de référence) */
  last: AnalysisInput | null = null;
  next: ((input: AnalysisInput) => PhotoAiResult) | null = null;
  fail: Error | null = null;
  calls = 0;

  analyze(input: AnalysisInput): Promise<AnalysisOutput> {
    this.calls++;
    this.last = input;
    if (this.fail) return Promise.reject(this.fail);
    const result = this.next?.(input) ?? {
      products: input.catalog.map((p) => ({
        productId: p.id,
        present: p.own,
        facings: p.own ? 4 : null,
        price: null,
        confidence: 'high' as const,
      })),
      others: [],
      shelfScore: 80,
      notes: 'Analyse simulée.',
    };
    return Promise.resolve({
      result,
      model: 'fake',
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  }
}

// ------------------------------------------------------------ registre

export interface PhotoAiProviderInfo {
  id: PhotoAiProviderId;
  label: string;
  /** Clé présente dans la configuration du serveur */
  configured: boolean;
  model: string | null;
}

/**
 * Fournisseurs branchés sur la plateforme (ceux dont la clé est dans la configuration) ;
 * l'éditeur choisit l'actif dans la console. En mode simulé, l'IA simulée répond pour tous.
 */
export class PhotoAiProviders {
  constructor(
    private readonly byId: Partial<Record<PhotoAiProviderId, PhotoAiProvider>>,
    readonly fake: FakeProvider | null = null,
  ) {}

  get(choice: string | null): PhotoAiProvider | null {
    if (choice === 'off' || !choice) return null;
    return this.fake ?? this.byId[choice as PhotoAiProviderId] ?? null;
  }

  /** Au moins un fournisseur branché */
  get any() {
    return !!this.fake || Object.keys(this.byId).length > 0;
  }

  list(): PhotoAiProviderInfo[] {
    return Object.values(PhotoAiProviderId).map((id) => {
      const provider = this.get(id);
      return {
        id,
        label: PHOTO_AI_PROVIDER_LABELS[id],
        configured: !!provider,
        model: provider?.model ?? null,
      };
    });
  }
}

/**
 * Fournisseurs selon la configuration : chaque clé (ANTHROPIC_API_KEY, MISTRAL_API_KEY) branche
 * le sien. PHOTO_AI_PROVIDER=off coupe tout ; PHOTO_AI_PROVIDER=fake simule (tests, démos).
 */
export function providersFromEnv(): PhotoAiProviders {
  const mode = (process.env.PHOTO_AI_PROVIDER || '').toLowerCase();
  if (mode === 'off') return new PhotoAiProviders({});
  if (mode === 'fake') return new PhotoAiProviders({}, new FakeProvider());
  return new PhotoAiProviders({
    ...(process.env.ANTHROPIC_API_KEY
      ? { anthropic: new ClaudeProvider() }
      : {}),
    ...(process.env.MISTRAL_API_KEY ? { mistral: new MistralProvider() } : {}),
  });
}
