import logger from './logger.js';

interface EnvConfig {
  port: number;
  corsOrigin: string;
  nodeEnv: string;
  enrichmentConfigured: boolean;
}

export function validateEnv(): EnvConfig {
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${process.env.PORT}". Must be an integer 1–65535.`);
  }

  const corsOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const enrichmentConfigured = Boolean(process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY);
  const enrichmentProvider = process.env.DEEPSEEK_API_KEY ? 'deepseek'
    : process.env.OPENAI_API_KEY ? 'openai'
    : 'none';

  logger.info(
    { port, corsOrigin, nodeEnv, enrichment: enrichmentConfigured ? `configured (${enrichmentProvider})` : 'not_configured' },
    'Environment validated',
  );

  return { port, corsOrigin, nodeEnv, enrichmentConfigured };
}
