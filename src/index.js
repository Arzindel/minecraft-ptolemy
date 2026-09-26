'use strict';

require('./env').loadEnv();

const { MinecraftBridge } = require('./minecraft/bridge');
const { WebServer } = require('./web/server');

const UI_PORT = Number(process.env.PTOLEMY_UI_PORT) || 3000;
const MC_PORT = Number(process.env.PTOLEMY_MC_PORT) || 8080;
// If the ports are taken (say, another Ptolemy is running), both move up together: the second
// instance gets 3001 + 8081, the third 3002 + 8082, and so on.
const PORT_ATTEMPTS = 20;

/** Listen on UI_PORT + n and MC_PORT + n for the first n where both are free. */
async function listenOnFreePorts(bridge, web) {
  for (let n = 0; n < PORT_ATTEMPTS; n++) {
    try {
      await bridge.listen(MC_PORT + n);
    } catch (err) {
      if (err.code === 'EADDRINUSE') continue;
      throw err;
    }
    try {
      await web.listen(UI_PORT + n);
      return n;
    } catch (err) {
      bridge.close();
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw Object.assign(new Error(`no free ports between ${UI_PORT}/${MC_PORT} and ${UI_PORT + PORT_ATTEMPTS - 1}/${MC_PORT + PORT_ATTEMPTS - 1}`), { code: 'NOPORTS' });
}

async function main() {
  const bridge = new MinecraftBridge({ port: MC_PORT });
  const web = new WebServer({ port: UI_PORT, bridge });

  bridge.on('log', (text) => console.log(`[minecraft] ${text}`));

  let shifted;
  try {
    shifted = await listenOnFreePorts(bridge, web);
  } catch (err) {
    console.error(err.code === 'NOPORTS'
      ? `Couldn't start: ${err.message}. Close some of what's using them, or set PTOLEMY_UI_PORT / PTOLEMY_MC_PORT.`
      : err);
    process.exit(1);
  }

  console.log('');
  console.log('  Ptolemy is running');
  console.log(`  WebUI:        http://localhost:${web.port}`);
  console.log(`  In Minecraft: /connect localhost:${bridge.port}`);
  if (shifted) {
    console.log('');
    console.log(`  Ports ${UI_PORT}/${MC_PORT} were taken (another Ptolemy running?), so this one uses ${web.port}/${bridge.port}.`);
    console.log('  Both instances share the data/ folder: settings and world memory changed in one can be');
    console.log('  overwritten by the other.');
  }
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
