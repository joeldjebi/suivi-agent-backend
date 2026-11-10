import { ConfigService } from '@nestjs/config';
import { TurnstileService } from './turnstile.service';

function service(secret?: string): TurnstileService {
  const config = {
    get: (key: string) => (key === 'TURNSTILE_SECRET' ? secret : undefined),
  } as unknown as ConfigService;
  return new TurnstileService(config);
}

describe('TurnstileService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('désactivé sans clé secrète : ne vérifie rien, laisse passer', async () => {
    const s = service(undefined);
    expect(s.enabled).toBe(false);
    const fetchMock = jest.fn();
    global.fetch = fetchMock;
    await expect(s.verify(undefined)).resolves.toBeUndefined();
    await expect(s.verify('un-jeton')).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('activé : jeton manquant refusé (403 CAPTCHA_REQUIRED)', async () => {
    const s = service('secret');
    expect(s.enabled).toBe(true);
    await expect(s.verify(undefined)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('activé : jeton valide accepté, jeton invalide refusé', async () => {
    const s = service('secret');
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ json: () => Promise.resolve({ success: true }) })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ success: false }),
      })
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ success: true }),
      });
    await expect(s.verify('bon')).resolves.toBeUndefined();
    await expect(s.verify('mauvais')).rejects.toMatchObject({ status: 403 });
    // L'adresse IP est transmise à Cloudflare quand elle est fournie.
    await s.verify('bon', '203.0.113.5');
    const call = (global.fetch as jest.Mock).mock.calls[2][1] as {
      body: URLSearchParams;
    };
    expect(call.body.get('remoteip')).toBe('203.0.113.5');
    expect(call.body.get('response')).toBe('bon');
  });

  it('Cloudflare injoignable : on ne bloque pas (disponibilité)', async () => {
    const s = service('secret');
    global.fetch = jest.fn().mockRejectedValue(new Error('réseau'));
    await expect(s.verify('jeton')).resolves.toBeUndefined();
  });
});
