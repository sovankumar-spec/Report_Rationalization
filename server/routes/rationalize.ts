import { Router, type Request, type Response, type NextFunction } from 'express';
import logger from '../lib/logger.js';

const router = Router();

function parseJsonFromText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Analysis response did not contain valid JSON.');
    return JSON.parse(match[0]);
  }
}

const SYSTEM_PROMPT = [
  'You are an enterprise BI modernization architect.',
  'You are given source reports, reference reports, and a deterministic overlap result computed from KPI alias, column, and normalized-table matches.',
  'Do not recompute the overlap percent. Do not change the decision band. Both are mathematical facts.',
  'Your job is qualitative:',
  '1. Produce a precise, evidence-based rationale in 3 to 5 sentences explaining why the overlap and band make sense from the SQL/KPI evidence.',
  '2. List specific KPI aliases that are present in the source but missing in the mapped reference as kpiGaps.',
  '3. Assess confidence in the rationale from 0 to 1: high when KPI semantics are clear, low when SQL is ambiguous or KPIs are sparse.',
  'For each source, echo back the supplied numeric fields verbatim: sourceId, sourceName, domain, targetId, targetName, overlapPercent, decision.',
  'Return strict JSON only. No markdown, no commentary outside JSON.',
].join(' ');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['decisions'],
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'sourceId',
          'sourceName',
          'domain',
          'targetId',
          'targetName',
          'overlapPercent',
          'decision',
          'confidenceScore',
          'rationale',
          'kpiGaps',
        ],
        properties: {
          sourceId:        { type: 'string' },
          sourceName:      { type: 'string' },
          domain:          { type: 'string' },
          targetId:        { type: ['string', 'null'] },
          targetName:      { type: ['string', 'null'] },
          overlapPercent:  { type: 'number', minimum: 0, maximum: 100 },
          decision:        { type: 'string', enum: ['Migrate', 'Consolidate', 'Rationalize'] },
          confidenceScore: { type: 'number', minimum: 0, maximum: 1 },
          rationale:       { type: 'string' },
          kpiGaps:         { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// ---- OpenAI Responses API ------------------------------------------------

function extractOpenAIText(data: Record<string, unknown>): string {
  if (typeof data.output_text === 'string') return data.output_text;
  const textParts: string[] = [];
  for (const item of (data.output as Array<{ content?: Array<{ text?: string }> }>) ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') textParts.push(content.text);
    }
  }
  return textParts.join('\n');
}

async function runOpenAIEnrichment(apiKey: string, body: unknown): Promise<unknown> {
  const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  const upstream = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(body) },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'report_rationalization',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    logger.warn({ status: upstream.status, err }, 'OpenAI rationale enrichment failed');
    throw new Error(`OpenAI enrichment failed with status ${upstream.status}.`);
  }

  const data = await upstream.json() as Record<string, unknown>;
  return parseJsonFromText(extractOpenAIText(data));
}

// ---- DeepSeek chat completions API (OpenAI-compatible) -------------------

async function runDeepSeekEnrichment(apiKey: string, body: unknown): Promise<unknown> {
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const upstream = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: JSON.stringify(body) },
      ],
      response_format: { type: 'json_object' },
      stream: false,
    }),
  });

  if (!upstream.ok) {
    const err = await upstream.json().catch(() => ({}));
    logger.warn({ status: upstream.status, err }, 'DeepSeek rationale enrichment failed');
    throw new Error(`DeepSeek enrichment failed with status ${upstream.status}.`);
  }

  const data = await upstream.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('DeepSeek returned an empty response.');
  return parseJsonFromText(text);
}

// ---- Provider selection --------------------------------------------------
// DeepSeek is checked first; OpenAI is the fallback.

async function runRationaleEnrichment(body: unknown): Promise<unknown> {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey   = process.env.OPENAI_API_KEY;

  if (deepseekKey) {
    logger.info('Rationale enrichment: using DeepSeek');
    return runDeepSeekEnrichment(deepseekKey, body);
  }
  if (openaiKey) {
    logger.info('Rationale enrichment: using OpenAI');
    return runOpenAIEnrichment(openaiKey, body);
  }
  throw new Error('No AI provider configured.');
}

// ---- Route ---------------------------------------------------------------

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const deepseekKey = process.env.DEEPSEEK_API_KEY;
  const openaiKey   = process.env.OPENAI_API_KEY;

  if (!deepseekKey && !openaiKey) {
    res.json({
      status:    'not_configured',
      message:   'Rationale enrichment is not configured on the server.',
      decisions: [],
    });
    return;
  }

  const requestId = req.headers['x-request-id'];
  logger.info({ requestId }, 'Running rationalization analysis');

  let parsed: unknown;
  try {
    parsed = await runRationaleEnrichment(req.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Rationale enrichment failed.';
    logger.warn({ requestId, err: msg }, 'Rationale enrichment failed, returning graceful fallback');
    res.json({
      status:    'error',
      message:   'Rationale enrichment unavailable — dispositions reflect KPI overlap scoring only.',
      decisions: [],
    });
    return;
  }

  try {
    const decisions = (parsed as { decisions?: unknown[] }).decisions ?? [];
    res.json({
      status:      'ok',
      model:       'Configured',
      generatedAt: new Date().toISOString(),
      decisions:   decisions.map((d: unknown) => {
        const dec = d as Record<string, unknown>;
        return {
          ...dec,
          overlapPercent:  Math.round(Number(dec.overlapPercent)),
          confidenceScore: Number(dec.confidenceScore),
          status:          'Pending',
          source:          'analysis',
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
