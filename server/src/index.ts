import { createApp } from './app.js';
import { config } from './core/config.js';
import { getDb } from './db/index.js';
import { logger } from './core/logger.js';
import { startWorker } from './modules/processing/queue.js';
import { registerPipelineHandlers } from './modules/processing/pipeline.js';
import { registerComplianceHandlers } from './modules/compliance/jobs.js';
import { rulesCorpusStatus } from './modules/compliance/rulesContext.js';
import { mockComponents, providerModelVersions } from './providers/registry.js';
import { seedIfEmpty, seedDemoInspections } from './db/seed.js';
import { syncRolePermissions } from './modules/auth/service.js';

const db = getDb();
// Keep role_permissions in step with the code matrix on every boot — an existing
// database that predates the three-role model is remapped by migration 003 and
// then re-mirrored here.
syncRolePermissions(db);
seedIfEmpty(db);
registerPipelineHandlers();
registerComplianceHandlers();
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
  const rules = rulesCorpusStatus();
  if (rules.available) {
    logger.info('statutory corpus available to the compliance judge',
      { sources: rules.sources, chars: rules.chars, sha256: rules.sha256.slice(0, 12) });
  } else {
    logger.warn(`No statutory corpus found in ${rules.directory} — the compliance judge cannot read the `
      + 'Legal Metrology (Packaged Commodities) Rules, 2011. Run: node scripts/extract-rules.mjs');
  }
  if (config.secret.includes('dev-only')) {
    logger.warn('Using the built-in development secret. Set PACKCOMPLY_SECRET before any real deployment.');
  }
});
