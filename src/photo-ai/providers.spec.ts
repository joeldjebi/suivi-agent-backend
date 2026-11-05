import {
  ClaudeProvider,
  MistralProvider,
  PermanentAnalysisError,
} from './providers';

const catalog = [
  {
    id: 'id-coca',
    name: 'Coca-Cola',
    brand: 'Coca-Cola',
    format: '33 cl',
    category: 'Boissons',
    own: true,
  },
  {
    id: 'id-pepsi',
    name: 'Pepsi',
    brand: 'PepsiCo',
    format: '33 cl',
    category: 'Boissons',
    own: false,
  },
];

/** Fournisseur Claude dont l'appel au modèle est simulé (aucune requête réseau). */
function provider(response: unknown) {
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-test';
  const p = new ClaudeProvider();
  const parse = jest.fn().mockResolvedValue(response);
  (
    p as unknown as { client: { beta: { messages: { parse: jest.Mock } } } }
  ).client = {
    beta: { messages: { parse } },
  };
  return { p, parse };
}

const input = { image: Buffer.from('img'), mime: 'image/jpeg', catalog };

describe('ClaudeProvider', () => {
  it('codes du catalogue traduits en produits, valeurs bornées, coût calculé', async () => {
    const { p, parse } = provider({
      stop_reason: 'end_turn',
      model: 'claude-opus-5-5',
      usage: { input_tokens: 2000, output_tokens: 500 },
      parsed_output: {
        products: [
          {
            ref: 'P1',
            present: true,
            facings: 6,
            price: 350,
            confidence: 'high',
          },
          // Code inventé et doublon : ignorés.
          {
            ref: 'P9',
            present: true,
            facings: 2,
            price: null,
            confidence: 'low',
          },
          {
            ref: 'P1',
            present: false,
            facings: 0,
            price: null,
            confidence: 'low',
          },
          {
            ref: 'P2',
            present: false,
            facings: -3,
            price: 0,
            confidence: 'medium',
          },
        ],
        others: [{ name: 'Youki', brand: null, facings: 3 }],
        shelfScore: 140,
        notes: 'Rayon bien rempli.',
      },
    });
    const out = await p.analyze(input);
    expect(out.result.products).toEqual([
      {
        productId: 'id-coca',
        present: true,
        facings: 6,
        price: 350,
        confidence: 'high',
      },
      {
        productId: 'id-pepsi',
        present: false,
        facings: 0,
        price: null,
        confidence: 'medium',
      },
    ]);
    expect(out.result.shelfScore).toBe(100);
    expect(out.result.others).toEqual([
      { name: 'Youki', brand: null, facings: 3 },
    ]);
    expect(out.costUsd).toBeCloseTo((2000 * 4 + 500 * 20) / 1_000_000);

    // Requête : modèle par défaut, image en base64, catalogue en codes, repli en cas de refus.
    const params = parse.mock.calls[0][0];
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.messages[0].content[1].source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: Buffer.from('img').toString('base64'),
    });
    expect(params.messages[0].content[2].text).toContain(
      'P2 · Pepsi · marque PepsiCo · 33 cl · Boissons · concurrent',
    );
  });

  it('refus du modèle : erreur définitive ; réponse tronquée : erreur passagère', async () => {
    await expect(
      provider({
        stop_reason: 'refusal',
        parsed_output: null,
        usage: {},
      }).p.analyze(input),
    ).rejects.toBeInstanceOf(PermanentAnalysisError);
    const truncated = provider({
      stop_reason: 'max_tokens',
      parsed_output: null,
      usage: {},
    });
    await expect(truncated.p.analyze(input)).rejects.not.toBeInstanceOf(
      PermanentAnalysisError,
    );
  });
});

describe('MistralProvider', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function mockFetch(status: number, body: unknown) {
    const fetch = jest.fn().mockResolvedValue({
      ok: status < 400,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    global.fetch = fetch;
    return fetch;
  }

  it('sortie JSON stricte, références en images, codes retraduits, coût', async () => {
    const fetch = mockFetch(200, {
      model: 'mistral-large-2512',
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              products: [
                {
                  ref: 'P1',
                  present: true,
                  facings: 4,
                  price: 300,
                  confidence: 'high',
                },
                {
                  ref: 'P7',
                  present: true,
                  facings: 1,
                  price: null,
                  confidence: 'low',
                },
              ],
              others: [],
              shelfScore: 65,
              notes: 'Correct.',
            }),
          },
        },
      ],
      usage: { prompt_tokens: 3000, completion_tokens: 400 },
    });
    const p = new MistralProvider('cle-test');
    const out = await p.analyze({
      ...input,
      references: [
        { productId: 'id-pepsi', image: Buffer.from('ref'), mime: 'image/png' },
        { productId: 'inconnu', image: Buffer.from('x'), mime: 'image/png' },
      ],
    });
    expect(out.result.products).toEqual([
      {
        productId: 'id-coca',
        present: true,
        facings: 4,
        price: 300,
        confidence: 'high',
      },
    ]);
    expect(out.model).toBe('mistral-large-2512');
    expect(out.costUsd).toBeCloseTo((3000 * 0.7 + 400 * 2.1) / 1_000_000);

    const [url, init] = fetch.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer cle-test');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('mistral-large-4');
    expect(body.response_format.type).toBe('json_schema');
    // Mistral exige top_p = 1 avec une température de 0 (sinon erreur 400).
    expect(body).toMatchObject({ temperature: 0, top_p: 1 });
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(
      JSON.stringify(body.response_format.json_schema.schema),
    ).not.toContain('maximum');
    const content = body.messages[1].content;
    // Référence de P2 (Pepsi) seulement : l'identifiant inconnu est ignoré.
    expect(content[0].text).toBe('Photo de référence de P2 :');
    expect(content[1].image_url).toBe(
      `data:image/png;base64,${Buffer.from('ref').toString('base64')}`,
    );
    expect(content[3].image_url).toBe(
      `data:image/jpeg;base64,${Buffer.from('img').toString('base64')}`,
    );
    expect(content).toHaveLength(5);
  });

  it('requête refusée : définitive ; quota ou panne : passagère ; JSON invalide : passagère', async () => {
    const p = new MistralProvider('cle-test');
    mockFetch(422, { message: 'invalid image' });
    await expect(p.analyze(input)).rejects.toBeInstanceOf(
      PermanentAnalysisError,
    );
    mockFetch(429, { message: 'rate limit' });
    await expect(p.analyze(input)).rejects.not.toBeInstanceOf(
      PermanentAnalysisError,
    );
    mockFetch(200, {
      model: 'm',
      choices: [{ finish_reason: 'stop', message: { content: '{"oups":' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await expect(p.analyze(input)).rejects.toThrow(
      'Réponse du modèle illisible',
    );
  });
});
