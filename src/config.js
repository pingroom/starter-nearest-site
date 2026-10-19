import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readJson } from './io.js';
import { validateCatalog } from './nearest.js';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const credentialsPath = resolve(root, '.pingroom/credentials.json');
export function loadEnv() {
  try { process.loadEnvFile(resolve(root, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw new Error('Could not read project .env.'); }
}
export async function loadCredentials(env = process.env, path = credentialsPath) {
  let token, room;
  if (env.PINGROOM_TOKEN !== undefined || env.PINGROOM_ROOM !== undefined) { token = env.PINGROOM_TOKEN; room = env.PINGROOM_ROOM; }
  else {
    try { ({ token, room } = await readJson(path, 16_384)); }
    catch { throw new Error('Run npm run connect or supply a complete environment credential pair.'); }
  }
  if (typeof token !== 'string' || !token.trim() || typeof room !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(room.trim())) throw new Error('Provide both nonblank PINGROOM_TOKEN and PINGROOM_ROOM; partial pairs never borrow saved values.');
  return { token: token.trim(), room: room.trim().toUpperCase() };
}
export async function loadConfig(env = process.env) {
  let catalog;
  try { catalog = validateCatalog(await readJson(resolve(root, env.CATALOG_FILE || 'catalog.local.json'), 65_536)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error('Copy catalog.example.json to catalog.local.json and configure your sites and trusted sender UUIDs.'); throw error; }
  return { ...await loadCredentials(env), catalog,
    directory: resolve(root, env.STATE_DIR || '.plans'), receiptDirectory: resolve(root, env.RECEIPT_DIR || 'receipts') };
}
