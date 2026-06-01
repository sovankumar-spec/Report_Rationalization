import 'dotenv/config';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import logger from './lib/logger.js';
import { validateEnv } from './lib/env.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestTimeout } from './middleware/timeout.js';
import rateLimiter, { analyzeRateLimit } from './middleware/rateLimiter.js';
import healthRouter      from './routes/health.js';
import reportsRouter     from './routes/reports.js';
import rationalizeRouter from './routes/rationalize.js';

const env = validateEnv();

const app = express();

// ── security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: env.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'X-Request-ID'],
}));
app.set('trust proxy', 1);

// ── observability ─────────────────────────────────────────────────────────────
app.use(requestId);
app.use(pinoHttp({ logger, quietReqLogger: true }));

// ── body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '100mb' }));

// ── global rate limit + timeout ───────────────────────────────────────────────
app.use('/api/', rateLimiter);
app.use('/api/', requestTimeout(120_000));

// ── routes ────────────────────────────────────────────────────────────────────
app.use('/api/health',       healthRouter);
app.use('/api/load-reports', reportsRouter);
app.use('/api/rationalize',  analyzeRateLimit, rationalizeRouter);

// ── API 404 ───────────────────────────────────────────────────────────────────
app.use('/api/', (_req, res) => {
  res.status(404).json({ status: 'error', error: { code: 'NOT_FOUND', message: 'Route not found.' } });
});

// ── Static file serving (production) ─────────────────────────────────────────
if (env.nodeEnv === 'production') {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const distPath  = path.resolve(__dirname, '..', 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// ── error handler (must be last) ─────────────────────────────────────────────
app.use(errorHandler);

// ── server + graceful shutdown ────────────────────────────────────────────────
const server = http.createServer(app);

server.listen(env.port, () => {
  logger.info({ port: env.port, env: env.nodeEnv }, 'Server started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received — draining connections');
  server.close(err => {
    if (err) {
      logger.error({ err }, 'Error during server close');
      process.exit(1);
    }
    logger.info('Server closed cleanly');
    process.exit(0);
  });

  // Force exit after 15 s if connections hang
  setTimeout(() => {
    logger.warn('Forced exit after 15 s shutdown timeout');
    process.exit(1);
  }, 15_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', err => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'Unhandled promise rejection — shutting down');
  process.exit(1);
});

export default app;
