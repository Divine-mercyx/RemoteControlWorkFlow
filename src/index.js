import { loadConfig } from './config.js';
import { createServer } from './server.js';

const config = loadConfig();
const server = createServer(config);
const addr = await server.listen();
console.log(`[nolt-remote-support] listening on :${addr.port}  technician viewer: ${config.publicUrl}/tech.html`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
