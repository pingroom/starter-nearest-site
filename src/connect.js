import { mkdir, chmod, open, rename, rm } from 'node:fs/promises';
import { PingRoom } from '@pingroom/sdk';
import { credentialsPath, loadEnv } from './config.js';
import { privateRoom } from './nearest.js';

const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  loadEnv();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--room' || !/^[A-Za-z0-9_-]+$/.test(args[1]))) {
    throw new Error('Usage: npm run connect [-- --room ROOM_CODE]');
  }
  console.log('Install or open PingRoom and sign in: https://pingroom.io/i');
  console.log('Grant access to the standard private room receiving explicit location shares.');
  const client = new PingRoom({ baseUrl: 'https://api.pingroom.io', timeoutMs: 5000 });
  const pairing = await client.auth.startPairing({ agent_label: 'Nearest site suggestions' });
  console.log(`Approve this connection: ${pairing.pair_browser_url ?? pairing.pair_url}`);
  const active = await client.auth.waitForPairing(pairing, { signal: controller.signal });
  controller.signal.throwIfAborted();
  const room = (args[1] ?? (active.home_room ?? active.room)?.invite_code)?.toUpperCase();
  if (!room) throw new Error('No private room returned.');
  privateRoom(await client.rooms.list(), room);
  controller.signal.throwIfAborted();
  const directory = new URL('../.pingroom/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
  const temporary = new URL(`credentials-${process.pid}.tmp`, directory);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(`${JSON.stringify({ token: active.credential, room })}\n`);
    await file.sync(); await file.close(); file = undefined;
    await rename(temporary, credentialsPath);
  } finally { await file?.close(); await rm(temporary, { force: true }); }
  console.log('Connected. Private credentials saved in .pingroom/credentials.json. Copy catalog.example.json to catalog.local.json and configure trusted senders and sites, then run npm start -- SOURCE_UUID.');
} catch {
  console.error('Connection did not complete. Grant a standard private room; use npm run connect -- --room ROOM_CODE if it differs from the home room. Check the network and room membership.');
  process.exitCode = 1;
}
