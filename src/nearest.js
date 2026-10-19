import { createHash } from 'node:crypto';
import { extractLocationPing, locationPing } from '@pingroom/sdk';
import { openState, publishOutput } from './storage.js';
export const hash = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const uuid = (x) => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, expected) => object(x) && Object.keys(x).sort().join(',') === expected;
const printable = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max && /^[\x20-\x7e]+$/.test(x) && x === x.trim();
const id = (x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(x);
const coordinate = (x, max) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= max;
const same = (a, b) => hash(a) === hash(b);

export function timestamp(x) {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(x)) throw new Error('Invalid source timestamp.');
  const year = +x.slice(0, 4), month = +x.slice(5, 7), day = +x.slice(8, 10), value = Date.parse(x);
  if (!Number.isFinite(value) || year < 1000 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || +x.slice(11, 13) > 23 || +x.slice(14, 16) > 59 || +x.slice(17, 19) > 59) throw new Error('Invalid source timestamp.');
  return value;
}
export function validateCatalog(raw) {
  if (!keys(raw, 'maxAgeSeconds,maxRadiusKm,sites,trustedSenderIds') || !Array.isArray(raw.trustedSenderIds)
    || !raw.trustedSenderIds.length || raw.trustedSenderIds.length > 100 || raw.trustedSenderIds.some((x) => !uuid(x))
    || !Number.isInteger(raw.maxAgeSeconds) || raw.maxAgeSeconds < 60 || raw.maxAgeSeconds > 86400
    || typeof raw.maxRadiusKm !== 'number' || !Number.isFinite(raw.maxRadiusKm) || raw.maxRadiusKm <= 0 || raw.maxRadiusKm > 1000
    || !Array.isArray(raw.sites) || raw.sites.length > 100) throw new Error('Invalid catalog policy; see catalog.example.json and README.');
  const trustedSenderIds = raw.trustedSenderIds.map((x) => x.toLowerCase()).sort();
  if (new Set(trustedSenderIds).size !== trustedSenderIds.length) throw new Error('Duplicate trusted sender ID.');
  const sites = raw.sites.map((site) => {
    if (!keys(site, 'enabled,id,latitude,longitude,name') || !id(site.id) || !printable(site.name, 40)
      || !coordinate(site.latitude, 90) || !coordinate(site.longitude, 180) || typeof site.enabled !== 'boolean') throw new Error('Invalid site; provide ID, ASCII name, finite coordinates, and enabled boolean.');
    return { id: site.id, name: site.name, latitude: site.latitude, longitude: site.longitude, enabled: site.enabled };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(sites.map((x) => x.id)).size !== sites.length) throw new Error('Duplicate site ID.');
  return { trustedSenderIds, maxAgeSeconds: raw.maxAgeSeconds, maxRadiusKm: raw.maxRadiusKm, sites };
}
export function privateRoom(rooms, code) {
  const room = Array.isArray(rooms) ? rooms.find((r) => r?.invite_code?.toUpperCase() === code) : null;
  if (!room || room.type !== 'standard' || room.is_public !== false || !Array.isArray(room.members)
    || new Set(room.members.filter((m) => uuid(m?.user_id)).map((m) => m.user_id.toLowerCase())).size < 2) throw new Error('Use a granted standard private room with at least two human members and visible membership.');
  return room;
}
function sourceFor(n, notificationId, room, catalog, now) {
  if (!object(n) || n.id !== notificationId || n.room?.invite_code?.toUpperCase() !== room.invite_code.toUpperCase()
    || n.room?.type !== 'standard' || n.room?.is_public !== false || !uuid(n.sender_id) || n.sender?.id !== n.sender_id
    || !catalog.trustedSenderIds.includes(n.sender_id.toLowerCase()) || !room.members.some((m) => m?.user_id?.toLowerCase() === n.sender_id.toLowerCase())
    || n.sender?.is_agent === true || n.origin_agent != null || !['manual', 'location'].includes(n.trigger_source)
    || n.is_handoff !== false || n.question !== null || n.audience_mode !== null || n.target_user_id !== null) throw new Error('Source must be an explicit location share from a trusted human in the selected private room.');
  const created = timestamp(n.created_at);
  if (created > now || now - created > catalog.maxAgeSeconds * 1000) throw new Error('Source is future-dated or too old; obtain a fresh explicit share.');
  const point = extractLocationPing(n.data);
  if (!point) throw new Error('Source has no valid finite location coordinates.');
  return { notificationId, senderId: n.sender_id.toLowerCase(), createdAt: n.created_at, latitude: point.latitude, longitude: point.longitude };
}
/** Spherical great-circle distance, not driving distance or travel time. */
export function distanceKm(a, b) {
  const rad = (n) => n * Math.PI / 180;
  const lat = rad(b.latitude - a.latitude), lon = rad(b.longitude - a.longitude);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(lon / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}
export function nearestSite(source, catalog) {
  let winner = null;
  for (const site of catalog.sites) {
    if (!site.enabled) continue;
    const distance = distanceKm(source, site);
    if (distance > catalog.maxRadiusKm) continue;
    // Catalog is sorted by ID: distances within a micrometre use that stable tie-break.
    if (!winner || distance < winner.distanceKm - 1e-9 || (Math.abs(distance - winner.distanceKm) <= 1e-9 && site.id < winner.id)) winner = { id: site.id, name: site.name, latitude: site.latitude, longitude: site.longitude, distanceKm: distance };
  }
  return winner;
}
function requestFor(proof, reviewHash) {
  const site = proof.selection;
  if (!site) return null;
  return { title: 'Suggested service site', message: `${site.name}: about ${Math.round(site.distanceKm * 1000)} m from the shared point.`,
    reply_to: proof.source.notificationId, correlation_id: `nearest-site-${reviewHash}`,
    data: { ...locationPing({ latitude: site.latitude, longitude: site.longitude, label: site.name }), site_id: site.id, review_hash: reviewHash } };
}
function validateSaved(state) {
  const p = state?.proof;
  if (!object(state) || state.version !== 1 || !['planned', 'sending', 'sent'].includes(state.phase) || !object(p)
    || !keys(p, 'catalogHash,credentialHash,room,selection,source') || !/^[a-f0-9]{64}$/.test(p.catalogHash)
    || !/^[a-f0-9]{64}$/.test(p.credentialHash) || typeof p.room !== 'string' || !/^[A-Z0-9_-]{1,64}$/.test(p.room)
    || !keys(p.source, 'createdAt,latitude,longitude,notificationId,senderId') || !uuid(p.source.notificationId) || !uuid(p.source.senderId)
    || !coordinate(p.source.latitude, 90) || !coordinate(p.source.longitude, 180)
    || (p.selection !== null && (!keys(p.selection, 'distanceKm,id,latitude,longitude,name') || !id(p.selection.id) || !printable(p.selection.name, 40)
      || !coordinate(p.selection.latitude, 90) || !coordinate(p.selection.longitude, 180) || !Number.isFinite(p.selection.distanceKm) || p.selection.distanceKm < 0))
    || state.reviewHash !== hash(p) || !same(state.request, requestFor(p, state.reviewHash))
    || (state.phase === 'sent' ? !uuid(state.sentId) : state.sentId !== null)) throw new Error('Invalid saved plan; restore a valid backup.');
  timestamp(p.source.createdAt);
}
function verifyRecovery(n, state) {
  const r = state.request;
  if (!uuid(n?.id) || n.room?.invite_code?.toUpperCase() !== state.proof.room || n.room?.type !== 'standard' || n.room?.is_public !== false
    || n.notification_title !== r.title || n.message !== r.message || n.reply_to !== r.reply_to || n.correlation_id !== r.correlation_id
    || n.is_handoff !== false || n.question !== null || n.audience_mode !== null || n.target_user_id !== null || n.requires_ack !== false || n.is_urgent !== false || !uuid(n.origin_agent?.id)
    || !object(n.data) || n.data.site_id !== r.data.site_id || n.data.review_hash !== r.data.review_hash
    || !same(extractLocationPing(n.data), r.data.location) || Object.keys(n.data).sort().join(',') !== 'location,review_hash,site_id') throw new Error('Recovery notification does not match the reviewed suggestion.');
}

/** Default operation is read-only planning; sending requires the exact review hash. */
export async function runNearest({ client, token, room, catalog: raw, notificationId, directory, receiptDirectory, operation = 'plan', reviewHash, sentId, now = Date.now }) {
  const catalog = validateCatalog(raw);
  if (!uuid(notificationId) || typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room)) throw new Error('Provide a source UUID and complete connection.');
  notificationId = notificationId.toLowerCase(); room = room.toUpperCase();
  if (!['plan', 'send', 'recover'].includes(operation) || (operation === 'send' && !/^[a-f0-9]{64}$/.test(reviewHash)) || (operation === 'recover' && !uuid(sentId))) throw new Error('Invalid operation; sending needs the exact review hash, recovery needs a notification UUID.');
  const store = await openState(directory, notificationId);
  try {
    let state = await store.read();
    if (state) {
      validateSaved(state);
      if (state.proof.source.notificationId !== notificationId || state.proof.room !== room || state.proof.credentialHash !== hash(token)) throw new Error('Saved source belongs to another room or connection.');
    }
    const receipt = async () => {
      const value = { version: 1, status: 'sent', reviewHash: state.reviewHash, notificationId: state.sentId, sourceNotificationId: notificationId, room,
        site: state.proof.selection, sourceHash: hash(state.proof.source), catalogHash: state.proof.catalogHash };
      return { status: 'already_sent', receiptPath: await publishOutput(receiptDirectory, `${notificationId}.json`, value), receipt: value };
    };
    if (state?.phase === 'sent') return await receipt();
    if (state?.phase === 'sending' && operation !== 'recover') return { status: 'send_unknown', reviewHash: state.reviewHash };
    if (operation === 'recover') {
      if (state?.phase !== 'sending' || !state.request) throw new Error('No uncertain send to recover.');
      privateRoom(await client.rooms.list(), room);
      const n = await client.notifications.getNotification(sentId);
      if (n?.id !== sentId) throw new Error('Recovery returned a different notification ID.');
      verifyRecovery(n, state);
      state.phase = 'sent'; state.sentId = n.id; await store.write(state);
      return { ...await receipt(), status: 'recovered' };
    }
    if (operation === 'send' && (!state || state.reviewHash !== reviewHash || state.proof.catalogHash !== hash(catalog) || !state.request)) throw new Error('No matching reviewed plan with an eligible site. Run plan and review its current hash.');
    const visibleRoom = privateRoom(await client.rooms.list(), room);
    const source = sourceFor(await client.notifications.getNotification(notificationId), notificationId, visibleRoom, catalog, now());
    const proof = { source, catalogHash: hash(catalog), credentialHash: hash(token), room, selection: nearestSite(source, catalog) };
    const currentHash = hash(proof);
    if (operation === 'plan') {
      state = { version: 1, phase: 'planned', proof, reviewHash: currentHash, request: requestFor(proof, currentHash), sentId: null };
      await store.write(state);
      return { status: proof.selection ? 'planned' : 'no_site', reviewHash: currentHash, source: proof.source, selection: proof.selection, request: state.request };
    }
    if (currentHash !== state.reviewHash) throw new Error('Source or selection changed after review; run plan again.');
    state.phase = 'sending'; await store.write(state);
    let result;
    try { result = await client.broadcast(room, state.request); }
    catch { return { status: 'send_unknown', reviewHash: state.reviewHash }; }
    if (!uuid(result?.id) || result.audience_mode !== null || result.target_user_id !== null) return { status: 'send_unknown', reviewHash: state.reviewHash };
    state.phase = 'sent'; state.sentId = result.id; await store.write(state);
    return { ...await receipt(), status: 'sent' };
  } finally { await store.close(); }
}
