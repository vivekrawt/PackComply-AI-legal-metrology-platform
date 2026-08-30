import { createApp } from './app.js';
import { config } from './core/config.js';
import { getDb } from './db/index.js';
import { logger } from './core/logger.js';
import { startWorker } from './modules/processing/queue.js';
import { registerPipelineHandlers } from './modules/processing/pipeline.js';
import { mockComponents, providerModelVersions } from './providers/registry.js';
import { seedIfEmpty, seedDemoInspections } from './db/seed.js';

const db = getDb();
seedIfEmpty(db);
registerPipelineHandlers();
await seedDemoInspections(db).catch((e) => logger.error('demo seed failed', { error: String(e) }));
startWorker(db);

const app = createApp();
app.listen(config.port, () => {
  logger.info('PackComply AI server started', { port: config.port, env: config.env });
  const mocked = mockComponents();
  if (mocked.length > 0) {
    logger.warn(`DEMO PROVIDERS ACTIVE for: ${mocked.join(', ')} — these outputs are deterministic mocks, NOT production AI`,
      { mockComponents: mocked, providers: providerModelVersions() });
  }
  if (config.secret.includes('dev-only')) {
    logger.warn('Using the built-in development secret. Set PACKCOMPLY_SECRET before any real deployment.');
  }
});
