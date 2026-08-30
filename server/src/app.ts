import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { requestContext } from './middleware/context.js';
import { loadSession, csrfHeader } from './middleware/auth.js';
import { rateLimit } from './middleware/security.js';
import { errorHandler } from './middleware/errors.js';
import { coreRouter } from './routes/core.js';
import { caseworkRouter } from './routes/casework.js';
import { rulesRouter } from './routes/rules.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
      },
    },
  }));
  app.use(requestContext);
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  app.use(rateLimit(config.rateLimit.max));
  app.use(loadSession);

  // Per-request timing (NFR-OBS-01 / performance instrumentation hooks).
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) {
        logger.info('request', {
          method: req.method, path: req.path, status: res.statusCode,
          ms: Date.now() - start, correlationId: req.correlationId, actor: req.user?.id,
        });
      }
    });
    next();
  });

  app.use('/api/v1', csrfHeader, coreRouter, caseworkRouter, rulesRouter);

  // Serve the built PWA when present (single-container deployment).
  const webDist = path.resolve(process.cwd(), '../web/dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use(errorHandler);
  return app;
}
