import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNearest, nearestSite, distanceKm, validateCatalog } from '../src/nearest.js';
import { offline, source, room, sampleCatalog, SOURCE_ID, SENT_ID, PERSON, NOW } from '../src/offline.js';
import { loadCredentials, loadConfig, root } from '../src/config.js';
import { readBounded, readJson } from '../src/io.js';
async function fixture(t, hooks = {}) {
  const base = await mkdtemp(join(tmpdir(), 'nearest-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const mock = offline(hooks);
  const options = { client: mock.client, token: 'offline-token', room: 'DEMO', catalog: structuredClone(sampleCatalog), notificationId: SOURCE_ID,
    directory: join(base, 'state'), receiptDirectory: join(base, 'receipts'), now: () => NOW };
  return { ...mock, base, options, run: (extra = {}) => runNearest({ ...options, ...extra }) };
}
const posts = (f) => f.calls.filter((c) => c.method === 'POST');
const statePath = (f) => join(f.options.directory, `${SOURCE_ID}.json`);

test('read-only plan selects nearest enabled site; explicit reviewed send publishes its location once', async (t) => {
  const f = await fixture(t); const plan = await f.run(); assert.equal(plan.status, 'planned'); assert.equal(plan.selection.id, 'north'); assert.equal(posts(f).length, 0);
  const result = await f.run({ operation: 'send', reviewHash: plan.reviewHash }); assert.equal(result.status, 'sent');
  assert.equal(posts(f)[0].body.data.location.latitude, 25.21); assert.equal(posts(f)[0].body.reply_to, SOURCE_ID);
  assert.equal(JSON.parse(await readFile(result.receiptPath)).sourceNotificationId, SOURCE_ID);
  assert.equal((await f.run({ operation: 'send', reviewHash: plan.reviewHash })).status, 'already_sent'); assert.equal(posts(f).length, 1);
});

test('wrong review hash cannot send', async (t) => {
  const f = await fixture(t); await f.run(); await assert.rejects(f.run({ operation: 'send', reviewHash: '0'.repeat(64) }), /matching reviewed plan/); assert.equal(posts(f).length, 0);
});

test('changed catalog invalidates old review and can be replanned before sending', async (t) => {
  const f = await fixture(t); const first = await f.run(); const catalog = structuredClone(sampleCatalog); catalog.sites[0].enabled = false;
  await assert.rejects(f.run({ operation: 'send', reviewHash: first.reviewHash, catalog }), /matching reviewed plan/);
  const second = await f.run({ catalog }); assert.equal(second.selection.id, 'south'); assert.notEqual(second.reviewHash, first.reviewHash);
  await assert.rejects(f.run({ operation: 'send', reviewHash: first.reviewHash, catalog }), /matching reviewed plan/);
});

test('empty, disabled, and out-of-radius catalogs yield no site and cannot send', async (t) => {
  const f = await fixture(t);
  for (const catalog of [{ ...sampleCatalog, sites: [] }, { ...sampleCatalog, sites: sampleCatalog.sites.map((s) => ({ ...s, enabled: false })) }, { ...sampleCatalog, maxRadiusKm: 0.001 }]) {
    const p = await f.run({ catalog }); assert.equal(p.status, 'no_site'); assert.equal(p.request, null);
    await assert.rejects(f.run({ catalog, operation: 'send', reviewHash: p.reviewHash }), /eligible site/);
  }
  assert.equal(posts(f).length, 0);
});

test('spherical distance handles antimeridian and identical points', () => {
  assert.equal(distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 }), 0);
  const d = distanceKm({ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }); assert.ok(d > 22 && d < 23);
});

test('equal-distance ties resolve by site ID regardless of catalog order', () => {
  const sites = [{ id: 'z', name: 'Z', latitude: 0, longitude: -1, enabled: true }, { id: 'a', name: 'A', latitude: 0, longitude: 1, enabled: true }];
  for (const rows of [sites, [...sites].reverse()]) assert.equal(nearestSite({ latitude: 0, longitude: 0 }, { sites: rows, maxRadiusKm: 200 }).id, 'a');
});

for (const [label, change] of [
  ['untrusted owner', (n) => { n.sender_id = SENT_ID; n.sender.id = SENT_ID; }],
  ['mismatched nested sender', (n) => { n.sender.id = SENT_ID; }],
  ['agent provenance', (n) => { n.origin_agent = { id: SENT_ID }; }],
  ['webhook origin', (n) => { n.trigger_source = 'webhook'; }],
  ['public source room', (n) => { n.room.is_public = true; }],
  ['wrong source room', (n) => { n.room.invite_code = 'OTHER'; }],
  ['targeted source', (n) => { n.audience_mode = 'targeted'; n.target_user_id = PERSON; }],
  ['question source', (n) => { n.question = { id: SENT_ID }; }],
]) {
  test(`refuses ${label}`, async (t) => {
    const f = await fixture(t, { onSource: (n) => { change(n); return Response.json(n); } });
    await assert.rejects(f.run(), /trusted human/); assert.equal(posts(f).length, 0);
  });
}
for (const [label, point] of [
  ['string coordinate', { latitude: '25.2', longitude: 55.2 }], ['out-of-range latitude', { latitude: 91, longitude: 55.2 }],
  ['missing coordinate', { latitude: 25.2 }], ['null coordinate', { latitude: null, longitude: 55.2 }],
]) {
  test(`refuses ${label}`, async (t) => {
    const f = await fixture(t, { onSource: (n) => Response.json({ ...n, data: { location: point } }) });
    await assert.rejects(f.run(), /finite location/);
  });
}
for (const created_at of ['2026-10-19T06:00:00Z', '2026-10-18T00:00:00Z', '2026-02-31T05:00:00Z']) {
  test(`refuses invalid source time ${created_at}`, async (t) => {
    const f = await fixture(t, { onSource: (n) => Response.json({ ...n, created_at }) }); await assert.rejects(f.run(), /timestamp|future-dated|too old/);
  });
}

test('source expiry between review and send blocks delivery', async (t) => {
  const f = await fixture(t); const p = await f.run();
  await assert.rejects(f.run({ operation: 'send', reviewHash: p.reviewHash, now: () => NOW + 3_600_000 }), /too old/); assert.equal(posts(f).length, 0);
});

test('changed source after review blocks delivery', async (t) => {
  let latitude = source.data.location.latitude;
  const f = await fixture(t, { onSource: (n) => Response.json({ ...n, data: { location: { latitude, longitude: 55.2708 } } }) });
  const p = await f.run(); latitude += 0.01;
  await assert.rejects(f.run({ operation: 'send', reviewHash: p.reviewHash }), /changed after review/); assert.equal(posts(f).length, 0);
});

test('lost POST response blocks retry and permits exact notification-ID recovery', async (t) => {
  const f = await fixture(t, { onSend: () => { throw new Error('Response lost'); } }); const p = await f.run();
  assert.equal((await f.run({ operation: 'send', reviewHash: p.reviewHash })).status, 'send_unknown');
  assert.equal((await f.run()).status, 'send_unknown'); assert.equal((await f.run({ operation: 'send', reviewHash: p.reviewHash })).status, 'send_unknown');
  assert.equal((await f.run({ operation: 'recover', sentId: SENT_ID })).status, 'recovered'); assert.equal(posts(f).length, 1);
});

test('uncertain recovery refuses different destination metadata', async (t) => {
  const f = await fixture(t, { onSend: () => { throw new Error('Lost'); }, onRecovery: (n) => Response.json({ ...n, data: { ...n.data, site_id: 'other' } }) });
  const p = await f.run(); await f.run({ operation: 'send', reviewHash: p.reviewHash });
  await assert.rejects(f.run({ operation: 'recover', sentId: SENT_ID }), /does not match/);
  assert.equal(JSON.parse(await readFile(statePath(f))).phase, 'sending');
});

test('durable sending journal is present before broadcast and stores no plaintext token', async (t) => {
  let f;
  f = await fixture(t, { onSend: async (n) => {
    const text = await readFile(statePath(f), 'utf8'); assert.equal(JSON.parse(text).phase, 'sending'); assert.ok(!text.includes('offline-token')); return Response.json(n);
  } }); const p = await f.run(); await f.run({ operation: 'send', reviewHash: p.reviewHash });
});

test('malformed successful POST does not create false delivery receipt', async (t) => {
  const f = await fixture(t, { onSend: () => Response.json({ ok: true }) }); const p = await f.run();
  assert.equal((await f.run({ operation: 'send', reviewHash: p.reviewHash })).status, 'send_unknown'); await assert.rejects(stat(f.options.receiptDirectory), { code: 'ENOENT' });
});

test('lost room grant or an empty roster prevents planning', async (t) => {
  for (const rooms of [[], [{ ...room, members: [] }]]) {
    const f = await fixture(t, { onRooms: () => rooms }); await assert.rejects(f.run(), /private room|trusted human/); assert.equal(posts(f).length, 0);
  }
});

test('exclusive lock and corrupt state cannot trigger sends', async (t) => {
  const f = await fixture(t); await mkdir(f.options.directory); await writeFile(join(f.options.directory, '.lock'), 'other'); await assert.rejects(f.run(), /locked/);
  await rm(join(f.options.directory, '.lock')); await writeFile(statePath(f), '{invalid'); await assert.rejects(f.run(), /Invalid state/); assert.equal(posts(f).length, 0);
});

test('changed credential cannot reuse source state', async (t) => {
  const f = await fixture(t); await f.run(); await assert.rejects(f.run({ token: 'different' }), /another room or connection/);
});

test('receipt conflicts preserve existing bytes; POSIX paths are private', async (t) => {
  const f = await fixture(t); const p = await f.run(); const sent = await f.run({ operation: 'send', reviewHash: p.reviewHash });
  if (process.platform !== 'win32') { assert.equal((await stat(statePath(f))).mode & 0o777, 0o600); assert.equal((await stat(f.options.directory)).mode & 0o777, 0o700); }
  await writeFile(sent.receiptPath, 'existing'); await assert.rejects(f.run(), /different contents/); assert.equal(await readFile(sent.receiptPath, 'utf8'), 'existing');
});

test('catalog rejects duplicate IDs, Unicode edge text, strings and nonfinite coordinates', () => {
  for (const change of [{ sites: [sampleCatalog.sites[0], sampleCatalog.sites[0]] }, { trustedSenderIds: [PERSON, PERSON] },
    { sites: [{ ...sampleCatalog.sites[0], name: ' Name' }] }, { sites: [{ ...sampleCatalog.sites[0], latitude: '25' }] },
    { sites: [{ ...sampleCatalog.sites[0], longitude: Infinity }] }]) assert.throws(() => validateCatalog({ ...sampleCatalog, ...change }));
});

test('actual bounded bytes, invalid UTF-8, and parse errors are rejected without payload disclosure', async (t) => {
  const f = await fixture(t); const path = join(f.base, 'input'); await writeFile(path, 'x'.repeat(50)); await assert.rejects(readBounded(path, 49), /byte limit/);
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path, 99), /valid UTF-8/);
  await writeFile(path, '{SECRET-BODY'); await assert.rejects(readJson(path, 99), (e) => !e.message.includes('SECRET') && /valid JSON/.test(e.message));
});

test('environment pair overrides saved credentials and partial pairs fail', async (t) => {
  const f = await fixture(t); const path = join(f.base, 'credentials'); await writeFile(path, JSON.stringify({ token: 'saved', room: 'demo' }));
  assert.deepEqual(await loadCredentials({}, path), { token: 'saved', room: 'DEMO' });
  assert.deepEqual(await loadCredentials({ PINGROOM_TOKEN: 'new', PINGROOM_ROOM: 'other' }, path), { token: 'new', room: 'OTHER' });
  await assert.rejects(loadCredentials({ PINGROOM_TOKEN: 'new' }, path), /both nonblank/);
});

test('config paths resolve against project root', async () => {
  const c = await loadConfig({ PINGROOM_TOKEN: 'offline', PINGROOM_ROOM: 'demo', CATALOG_FILE: 'catalog.example.json', STATE_DIR: 'some-state' });
  assert.equal(c.directory, join(root, 'some-state')); assert.equal(c.catalog.sites.length, 2);
});
