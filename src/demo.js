import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runNearest } from './nearest.js';
import { offline, SOURCE_ID, sampleCatalog, NOW } from './offline.js';
const directory = await mkdtemp(join(tmpdir(), 'nearest-site-demo-'));
try {
  const mock = offline();
  const options = { client: mock.client, token: 'offline-token', room: 'DEMO', catalog: sampleCatalog, notificationId: SOURCE_ID,
    directory: join(directory, 'state'), receiptDirectory: join(directory, 'receipts'), now: () => NOW };
  const plan = await runNearest(options);
  console.log('Read-only plan:', plan.status, plan.selection.name, `${Math.round(plan.selection.distanceKm * 1000)} m straight-line`);
  console.log('Broadcasts before explicit send:', mock.calls.filter((c) => c.method === 'POST').length);
  const sent = await runNearest({ ...options, operation: 'send', reviewHash: plan.reviewHash });
  console.log('Mock send:', sent.status);
  console.log(JSON.stringify(sent.receipt, null, 2));
  console.log('Replay:', (await runNearest({ ...options, operation: 'send', reviewHash: plan.reviewHash })).status);
  console.log('Total broadcast requests:', mock.calls.filter((c) => c.method === 'POST').length);
} finally { await rm(directory, { recursive: true, force: true }); }
