import type { Messaging, MulticastMessage } from 'firebase-admin/messaging';
import { FirebaseTransport } from './push.service';

/** Messagerie Firebase simulée : garde les envois, refuse les jetons « dead-… ». */
function fakeMessaging() {
  const sent: MulticastMessage[] = [];
  const messaging = {
    sendEachForMulticast: (message: MulticastMessage) => {
      sent.push(message);
      return Promise.resolve({
        responses: message.tokens.map((token) =>
          token.startsWith('dead-')
            ? {
                success: false,
                error: { code: 'messaging/registration-token-not-registered' },
              }
            : { success: true },
        ),
      });
    },
  };
  return {
    sent,
    transport: new FirebaseTransport(messaging as unknown as Messaging),
  };
}

describe('FirebaseTransport', () => {
  it('envoie une notification affichée par le téléphone, avec ses données', async () => {
    const { sent, transport } = fakeMessaging();
    const result = await transport.send(
      [
        { token: 'android-1', platform: 'android' },
        { token: 'dead-ios', platform: 'ios' },
      ],
      {
        type: 'mission.assigned',
        title: 'Nouvelle mission',
        body: 'Relevé de prix',
        data: { missionId: 'm1' },
      },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0].notification).toEqual({
      title: 'Nouvelle mission',
      body: 'Relevé de prix',
    });
    expect(sent[0].data).toEqual({ missionId: 'm1', type: 'mission.assigned' });
    expect(sent[0].android?.notification?.channelId).toBe('suivi_agent');
    expect(result.invalid).toEqual(['dead-ios']);
  });

  it('demande de zone : boutons via la catégorie iOS, message en données sur Android', async () => {
    const { sent, transport } = fakeMessaging();
    const result = await transport.send(
      [
        { token: 'ios-1', platform: 'ios' },
        { token: 'dead-android', platform: 'android' },
        { token: 'android-2', platform: 'android' },
      ],
      {
        type: 'zone_request.created',
        title: 'Demande de zone',
        body: 'Koffi demande Cocody',
        data: { requestId: 'r1' },
      },
    );
    expect(sent).toHaveLength(2);
    const [ios, android] = sent;
    expect(ios.tokens).toEqual(['ios-1']);
    expect(ios.apns?.payload?.aps.category).toBe('ZONE_REQUEST');
    expect(android.tokens).toEqual(['dead-android', 'android-2']);
    expect(android.notification).toBeUndefined();
    expect(android.data).toEqual({
      requestId: 'r1',
      type: 'zone_request.created',
      title: 'Demande de zone',
      body: 'Koffi demande Cocody',
      category: 'ZONE_REQUEST',
    });
    expect(result.invalid).toEqual(['dead-android']);
  });
});
