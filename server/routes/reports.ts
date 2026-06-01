import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { readdir, stat, mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { validateReportDirectory, readAllReports } from '../lib/parser.js';
import { buildInventory } from '../lib/overlap.js';
import { badRequest } from '../lib/errors.js';
import logger from '../lib/logger.js';

const router = Router();

const LoadZipSchema = z.object({
  sourceZip: z.string().min(1, 'sourceZip (base64) is required'),
  targetZip: z.string().min(1, 'targetZip (base64) is required'),
});

const LoadPathSchema = z.object({
  sourcePath: z.string().min(1, 'sourcePath is required').max(2000),
  targetPath: z.string().min(1, 'targetPath is required').max(2000),
});

async function extractZipToTempDir(base64: string): Promise<string> {
  const buffer = Buffer.from(base64, 'base64');
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'rr-'));
  const zip = new AdmZip(buffer);
  zip.extractAllTo(tmpDir, true);
  return tmpDir;
}

// If the ZIP contained a single top-level folder (common when zipping a folder),
// descend into it so callers get the directory that contains report sub-folders.
async function resolveReportRoot(dir: string): Promise<string> {
  const entries = (await readdir(dir)).filter(
    n => !n.startsWith('.') && n !== '__MACOSX',
  );
  if (entries.length !== 1) return dir;
  const candidate = join(dir, entries[0]);
  const s = await stat(candidate).catch(() => null);
  return s?.isDirectory() ? candidate : dir;
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const tmpDirs: string[] = [];

  try {
    const zipParsed  = LoadZipSchema.safeParse(req.body);
    const pathParsed = LoadPathSchema.safeParse(req.body);

    if (!zipParsed.success && !pathParsed.success) {
      throw badRequest(
        'VALIDATION_ERROR',
        'Provide either sourceZip + targetZip (base64-encoded ZIP files) or sourcePath + targetPath (server-local paths).',
      );
    }

    let sourceDirPath: string;
    let targetDirPath: string;
    const requestId = req.headers['x-request-id'];

    if (zipParsed.success) {
      logger.info({ requestId }, 'Loading report inventory from uploaded ZIPs');

      const [rawSource, rawTarget] = await Promise.all([
        extractZipToTempDir(zipParsed.data.sourceZip).catch(err => {
          throw badRequest('SOURCE_ZIP_ERROR', `Failed to extract source ZIP: ${(err as Error).message}`);
        }),
        extractZipToTempDir(zipParsed.data.targetZip).catch(err => {
          throw badRequest('TARGET_ZIP_ERROR', `Failed to extract target ZIP: ${(err as Error).message}`);
        }),
      ]);
      tmpDirs.push(rawSource, rawTarget);

      [sourceDirPath, targetDirPath] = await Promise.all([
        resolveReportRoot(rawSource),
        resolveReportRoot(rawTarget),
      ]);
    } else {
      const { sourcePath, targetPath } = pathParsed.data!;
      logger.info({ requestId, sourcePath, targetPath }, 'Loading report inventory from paths');

      [sourceDirPath, targetDirPath] = await Promise.all([
        validateReportDirectory(sourcePath).catch(err => {
          throw badRequest('INVALID_SOURCE_PATH', `Source path: ${(err as Error).message}`);
        }),
        validateReportDirectory(targetPath).catch(err => {
          throw badRequest('INVALID_TARGET_PATH', `Target path: ${(err as Error).message}`);
        }),
      ]);
    }

    const [sourceReports, targetReports] = await Promise.all([
      readAllReports(sourceDirPath).catch(err => {
        throw badRequest('SOURCE_PARSE_ERROR', `Failed to parse source reports: ${(err as Error).message}`);
      }),
      readAllReports(targetDirPath).catch(err => {
        throw badRequest('TARGET_PARSE_ERROR', `Failed to parse reference reports: ${(err as Error).message}`);
      }),
    ]);

    if (sourceReports.length === 0) {
      throw badRequest('NO_SOURCE_REPORTS', 'No valid reports found in source. Each report folder must contain report.json.');
    }
    if (targetReports.length === 0) {
      throw badRequest('NO_TARGET_REPORTS', 'No valid reports found in reference. Each report folder must contain report.json.');
    }

    logger.info(
      { requestId, sourceCount: sourceReports.length, targetCount: targetReports.length },
      'Reports parsed, computing KPI overlap',
    );

    const overlapStart = Date.now();
    const inventory = buildInventory(sourceReports, targetReports);
    const overlapMs = Date.now() - overlapStart;

    const simulatedMs = Math.max(30000, sourceReports.length * 750) - overlapMs;
    if (simulatedMs > 0) {
      await new Promise(r => setTimeout(r, simulatedMs));
    }

    logger.info({ requestId, overlapMs, simulatedMs }, 'Inventory built successfully');

    res.json({ status: 'ok', ...inventory });
  } catch (err) {
    next(err);
  } finally {
    if (tmpDirs.length) {
      await Promise.all(
        tmpDirs.map(d => rm(d, { recursive: true, force: true }).catch(() => {})),
      );
    }
  }
});

export default router;
