#!/usr/bin/env node
import { loadConfig } from './config.js';
import { RingForgePlugin } from './plugin.js';

async function main() {
  const config = await loadConfig();
  if (!config.enabled) {
    console.log('[openclaw] RingForge integration disabled');
    return;
  }

  const plugin = new RingForgePlugin(config);
  await plugin.start();

  const shutdown = async () => {
    await plugin.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[openclaw] fatal:', err);
  process.exit(1);
});
