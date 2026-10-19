import { PingRoom, PingRoomError } from '@pingroom/sdk';
import { loadEnv, loadConfig } from './config.js';
import { runNearest } from './nearest.js';
try {
  const [operation, notificationId, third, ...extra] = process.argv.slice(2);
  if (!notificationId || extra.length || (operation === 'plan' && third) || (!['plan', 'send', 'recover'].includes(operation))) throw new Error('Use npm start -- SOURCE_UUID; npm run send -- SOURCE_UUID REVIEW_HASH; or npm run recover -- SOURCE_UUID SENT_UUID.');
  loadEnv(); const config = await loadConfig();
  const client = new PingRoom({ token: config.token, baseUrl: 'https://api.pingroom.io', timeoutMs: 5000 });
  const result = await runNearest({ ...config, client, operation, notificationId, reviewHash: operation === 'send' ? third : undefined, sentId: operation === 'recover' ? third : undefined });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'no_site' ? 2 : result.status === 'send_unknown' ? 3 : 0;
} catch (error) {
  console.error(error instanceof PingRoomError ? 'PingRoom request failed. Check room access, credentials, limits, and network; preserve any uncertain send.' : error.code ? 'Local file operation failed. Check configured paths and permissions.' : error.message);
  process.exitCode = 1;
}
