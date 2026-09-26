'use strict';

require('./env').loadEnv();

const { MinecraftBridge } = require('./minecraft/bridge');
const { WebServer } = require('./web/server');

const UI_PORT = Number(process.env.PTOLEMY_UI_PORT) || 3000;
const MC_PORT = Number(process.env.PTOLEMY_MC_PORT) || 8080;

async function main() {
  const bridge = new MinecraftBridge({ port: MC_PORT });
  const web = new WebServer({ port: UI_PORT, bridge });

  bridge.on('log', (text) => console.log(`[minecraft] ${text}`));

  try {
    await bridge.listen();
    await web.listen();
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${err.port} is already in use. Close whatever is using it, or set PTOLEMY_UI_PORT / PTOLEMY_MC_PORT.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  console.log('');
  console.log('  Ptolemy is running');
  console.log(`  WebUI:        http://localhost:${UI_PORT}`);
  console.log(`  In Minecraft: /connect localhost:${MC_PORT}`);
  if (process.argv.includes('--watched')) { // set by `npm run start`, which runs under node --watch
    console.log('');
    console.log('  Watching for code changes: Ptolemy restarts itself after a git pull.');
    console.log('  Minecraft is disconnected by a restart, so run /connect again afterwards.');
  }
  console.log('');

  const shutdown = () => {
    console.log('\nShutting down...');
    bridge.close();
    web.close();
    process.exit(0);
  };
  // A bug in one request shouldn't take the whole server (and the game connection) down.
  process.on('unhandledRejection', (err) => console.error('[ptolemy] Unhandled error:', err));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
