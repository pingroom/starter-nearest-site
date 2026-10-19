import { PingRoom } from '@pingroom/sdk';
export const SOURCE_ID = 'ab08f0a3-80b9-4b18-a502-5432da167b29';
export const SENT_ID = 'ab08f0a3-80b9-4b18-a502-5432da167b30';
export const PERSON = 'a89fbac6-a02f-4848-a3b7-94c47184a537';
export const ROBOT = '39ba0844-5c60-44bf-8008-0adba11ca7d9';
export const NOW = Date.parse('2026-10-19T05:00:00Z');
export const sampleCatalog = { trustedSenderIds: [PERSON], maxAgeSeconds: 3600, maxRadiusKm: 20, sites: [
  { id: 'north', name: 'North service desk', latitude: 25.21, longitude: 55.28, enabled: true },
  { id: 'south', name: 'South service desk', latitude: 25.18, longitude: 55.27, enabled: true },
] };
export const room = { id: '3d60c74a-925f-4c23-a13a-1cb3bf0396d8', invite_code: 'DEMO', type: 'standard', is_public: false,
  members: [{ user_id: PERSON, role: 'owner' }, { user_id: SENT_ID, role: 'member' }] };
export const source = { id: SOURCE_ID, room, sender_id: PERSON, sender: { id: PERSON, name: 'Alex' }, trigger_source: 'manual',
  is_handoff: false, question: null, audience_mode: null, target_user_id: null, created_at: '2026-10-19T04:50:00.000000Z', data: { location: { latitude: 25.2048, longitude: 55.2708, label: 'Shared map point' } } };
/** Only the injected local transport runs. Unknown requests cannot fall through to a network. */
export function offline({ onSource, onRooms, onSend, onRecovery, timeoutMs = 5000 } = {}) {
  const calls = []; let sent;
  const client = new PingRoom({ token: 'offline-token', baseUrl: 'https://nearest-site.invalid', timeoutMs, fetch: async (url, init) => {
    const u = new URL(url); if (u.origin !== 'https://nearest-site.invalid') throw new Error('Unexpected offline origin.');
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method, path: u.pathname, body });
    if (init.method === 'GET' && u.pathname === '/api/agent/rooms') return Response.json(onRooms ? await onRooms() : [room]);
    if (init.method === 'GET' && u.pathname === `/api/agent/notifications/${SOURCE_ID}`) return onSource ? await onSource(structuredClone(source), init.signal) : Response.json(source);
    if (init.method === 'GET' && u.pathname === `/api/agent/notifications/${SENT_ID}` && sent) return onRecovery ? await onRecovery(structuredClone(sent)) : Response.json(sent);
    if (init.method === 'POST' && u.pathname === '/api/agent/rooms/DEMO/notifications') {
      sent = { id: SENT_ID, room, notification_title: body.title, message: body.message, data: body.data, correlation_id: body.correlation_id,
        reply_to: body.reply_to, audience_mode: null, target_user_id: null, is_handoff: false, question: null, requires_ack: false, is_urgent: false, origin_agent: { id: ROBOT } };
      return onSend ? await onSend(structuredClone(sent), init.signal) : Response.json(sent, { status: 201 });
    }
    throw new Error('Unexpected offline request.');
  } });
  return { client, calls };
}
