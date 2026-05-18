import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { mkdir, appendFile, readFile, writeFile } from "fs/promises";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod";
import { ensureDatabaseSchema, prisma } from "./db.js";
import { getSettings, updateSettings } from "./settings.js";
import { runEnrichment, runFieldProbe } from "./enrich.js";
import { browserManager } from "./browserManager.js";
import { runModelCompatibilityTest, fetchOllamaModelTags } from "./model.js";
import { migrateLegacyFields } from "./enrichmentFields.js";
import { migrateInputFields } from "./inputFields.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));
const fieldProbeJobs = new Map();
const enrichJobs = new Map();
const enrichmentApiLogPath = path.join(__dirname, "..", "logs", "enrichment-api.jsonl");
const execFileAsync = promisify(execFile);
let lastCpuSample = null;

const inputValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const enrichInputSchema = z
  .object({
    input: z.record(inputValueSchema).optional(),
    company: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    custom_1: z.string().optional(),
    website: z.string().optional().nullable()
  })
  .passthrough();

const fieldProbeSchema = enrichInputSchema.extend({
  field: z.string().min(1),
  queryTemplate: z.string().optional().nullable()
});

const enrichmentFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  evidenceSourceField: z.string().nullable().optional(),
  queryTemplates: z.string().optional(),
  promptTemplate: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).nullable().optional(),
  maxTokens: z.number().int().min(1).max(1200).nullable().optional()
});

const inputFieldSchema = z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional()
});

const settingsSchema = z.object({
  modelApiBaseUrl: z.string().url().optional(),
  modelName: z.string().min(1).optional(),
  modelApiKey: z.string().optional(),
  modelBasicAuth: z.string().optional(),
  publicApiKey: z.string().optional(),
  confidenceThreshold: z.number().min(0).max(1).optional(),
  ownerConfidenceThreshold: z.number().min(0).max(1).optional(),
  requestTimeoutMs: z.number().int().min(10000).max(180000).optional(),
  modelRequestTimeoutMs: z.number().int().min(10000).max(600000).optional(),
  evidenceRequestTimeoutMs: z.number().int().min(5000).max(180000).optional(),
  modelDisableThinking: z.boolean().optional(),
  modelReasoningEffort: z.enum(["none", "low", "medium", "high"]).optional(),
  ownerMaxTokens: z.number().int().min(1).max(400).optional(),
  fieldProbeMaxTokens: z.number().int().min(1).max(600).optional(),
  enrichMaxTokens: z.number().int().min(1).max(1200).optional(),
  cacheTtlHours: z.number().int().min(1).max(168).optional(),
  useCache: z.boolean().optional(),
  googleSerpOnly: z.boolean().optional(),
  useBrightDataSerp: z.boolean().optional(),
  brightDataSerpMode: z.enum(["request", "dataset", "ai_mode"]).optional(),
  brightDataApiToken: z.string().optional(),
  brightDataAiModeDatasetId: z.string().optional(),
  brightDataAiModeCountry: z.string().optional(),
  brightDataAiModeHtmlFallbackChars: z.number().int().min(500).max(50000).optional(),
  brightDataZone: z.string().optional(),
  brightDataFormat: z.string().optional(),
  brightDataDatasetId: z.string().optional(),
  brightDataDatasetInitialWaitMs: z.number().int().min(1000).max(120000).optional(),
  brightDataDatasetPollIntervalMs: z.number().int().min(1000).max(120000).optional(),
  brightDataDatasetMaxWaitMs: z.number().int().min(5000).max(600000).optional(),
  brightDataDatasetFallbackToRequest: z.boolean().optional(),
  profileSerpQueryTemplates: z.string().optional(),
  ownerSerpQueryTemplates: z.string().optional(),
  competitorSerpQueryTemplates: z.string().optional(),
  serviceSerpQueryTemplates: z.string().optional(),
  inputFields: z.array(inputFieldSchema).optional(),
  enrichmentFields: z.array(enrichmentFieldSchema).optional(),
  headed: z.boolean().optional(),
  rotateProxyPerSite: z.boolean().optional(),
  proxyRetryCount: z.number().int().min(0).max(5).optional(),
  browserMaxUses: z.number().int().min(1).max(100).optional(),
  proxyList: z.string().optional(),
  allowedSources: z.array(z.string()).optional()
});

function normalizeInput(body, settings) {
  const incoming = body?.input && typeof body.input === "object" ? body.input : {};
  const inputFields = migrateInputFields(settings);
  const out = {};

  for (const field of inputFields) {
    const key = field.key;
    let value = incoming[key];

    if (value === undefined && key === "company") value = body.company;
    if (value === undefined && key === "city") value = body.city;
    if (value === undefined && key === "state") value = body.state || body.custom_1;
    if (value === undefined && key === "website") value = body.website;

    out[key] = value === null || value === undefined ? "" : String(value).trim();
  }

  for (const [key, value] of Object.entries(incoming)) {
    if (out[key] !== undefined) continue;
    out[key] = value === null || value === undefined ? "" : String(value).trim();
  }

  if (out.company === undefined) out.company = String(body.company || "").trim();
  if (out.city === undefined) out.city = String(body.city || "").trim();
  if (out.state === undefined) out.state = String(body.state || body.custom_1 || "").trim();
  if (out.website === undefined) out.website = String(body.website || "").trim();

  return out;
}

function validateRequiredInput(input, settings) {
  const requiredFields = migrateInputFields(settings).filter((field) => field.required);
  const missing = requiredFields.filter((field) => !String(input[field.key] || "").trim());
  if (!missing.length) return;
  const label = missing.map((field) => field.label || field.key).join(", ");
  throw new Error(`Missing required input fields: ${label}`);
}

function isTimeoutLikeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("operation was aborted") ||
    message.includes("aborterror")
  );
}

function parseHttpStatusFromText(text) {
  const match = String(text || "").match(/\bhttp\s+(\d{3})\b/i);
  if (!match) return null;
  const status = Number(match[1]);
  return Number.isFinite(status) ? status : null;
}

function inferErrorSource(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
  const attemptUrls = attempts.map((item) => String(item?.url || "").toLowerCase());

  if (lower.startsWith("missing required input fields:")) return "validation";
  if (lower.includes("bright data") || lower.includes("brightdata")) return "brightdata";
  if (
    attemptUrls.some(
      (url) =>
        url.includes("/v1/chat/completions") ||
        url.includes("/chat/completions") ||
        url.includes("/api/generate") ||
        url.includes("/api/chat")
    )
  ) {
    return "qwen";
  }
  if (lower.includes("model ")) return "qwen";
  return "app";
}

function inferErrorType(error) {
  const message = String(error?.message || error || "");
  const lower = message.toLowerCase();
  const upstreamStatus = parseHttpStatusFromText(message);

  if (lower.startsWith("missing required input fields:")) return "validation_error";
  if (isTimeoutLikeError(error)) return "upstream_timeout";
  if (upstreamStatus) return `upstream_http_${upstreamStatus}`;
  if (lower.includes("json")) return "model_parse_error";
  return "internal_error";
}

function buildErrorMeta(error) {
  const source = inferErrorSource(error);
  const type = inferErrorType(error);
  const upstreamHttpStatus = parseHttpStatusFromText(String(error?.message || error || ""));
  return {
    error_source: source,
    error_type: type,
    upstream_http_status: upstreamHttpStatus
  };
}

function mapEnrichmentErrorToHttp(error) {
  const message = String(error?.message || error || "Unknown error");
  const meta = buildErrorMeta(error);
  if (message.startsWith("Missing required input fields:")) {
    return { status: 400, body: { ok: false, error: message, ...meta } };
  }
  if (isTimeoutLikeError(error)) {
    return {
      status: 504,
      body: {
        ok: false,
        error: message,
        code: "UPSTREAM_TIMEOUT",
        ...meta
      }
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      error: message,
      ...meta
    }
  };
}

function makeApiRequestId(prefix = "req") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function summarizeEvidenceForApiLog(debug) {
  const evidence = Array.isArray(debug?.evidenceDebug) ? debug.evidenceDebug : [];
  const aiModeEvidence = evidence
    .filter(
      (item) =>
        String(item?.aiAnswerText || "").trim() ||
        String(item?.aiAnswerMarkdown || "").trim() ||
        String(item?.aiAnswerHtmlText || "").trim() ||
        String(item?.aioText || "").trim()
    )
    .map((item) => ({
      field: item.field || null,
      mode: item.mode || null,
      provider: item.provider || null,
      query: item.query || null,
      url: item.url || null,
      aiAnswerText: String(item.aiAnswerText || "").slice(0, 4000),
      aiAnswerMarkdown: String(item.aiAnswerMarkdown || "").slice(0, 4000),
      aiAnswerHtmlText: String(item.aiAnswerHtmlText || "").slice(0, 4000),
      aioText: String(item.aioText || "").slice(0, 4000)
    }));
  return {
    evidenceCount: evidence.length,
    aiEvidenceCount: aiModeEvidence.length,
    aiEvidence: aiModeEvidence
  };
}

function summarizeQwenForApiLog(debug, result) {
  const fieldDebug = Array.isArray(debug?.fieldDebug) ? debug.fieldDebug : [];
  return {
    modelParsedBeforeThreshold: debug?.modelParsedBeforeThreshold || null,
    finalResult: result || null,
    fields: fieldDebug.map((field) => ({
      key: field.key,
      rawValue: field.rawValue,
      gatedValue: field.gatedValue,
      confidence: field.confidence,
      passDebug: Array.isArray(field.passDebug)
        ? field.passDebug.map((pass) => ({
            passName: pass.passName,
            rawValue: pass.rawValue,
            gatedValue: pass.gatedValue,
            confidence: pass.confidence,
            error: pass.error || null
          }))
        : []
    }))
  };
}

async function appendEnrichmentApiLog(entry) {
  try {
    await mkdir(path.dirname(enrichmentApiLogPath), { recursive: true });
    await appendFile(enrichmentApiLogPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error("failed to write enrichment api log:", error);
  }
}

async function readEnrichmentApiLogs(limit = 100) {
  try {
    const raw = await readFile(enrichmentApiLogPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // ignore bad line
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function clearEnrichmentApiLogs() {
  try {
    await mkdir(path.dirname(enrichmentApiLogPath), { recursive: true });
    await writeFile(enrichmentApiLogPath, "", "utf8");
  } catch (error) {
    console.error("failed to clear enrichment api log:", error);
    throw error;
  }
}

function getEnabledEnrichmentFields(settings) {
  return migrateLegacyFields(settings).filter((field) => field.enabled !== false);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function getCpuSample() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.irq + times.idle;
  }
  return { idle, total, cores: cpus.length };
}

function getCpuLoadPercent() {
  const current = getCpuSample();
  if (!lastCpuSample) {
    lastCpuSample = current;
    return null;
  }
  const idleDiff = current.idle - lastCpuSample.idle;
  const totalDiff = current.total - lastCpuSample.total;
  lastCpuSample = current;
  if (totalDiff <= 0) return null;
  const used = 1 - idleDiff / totalDiff;
  return Math.max(0, Math.min(100, round2(used * 100)));
}

async function getDiskUsage() {
  try {
    const { stdout } = await execFileAsync("df", ["-kP", "."]);
    const lines = String(stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean);
    if (lines.length < 2) return null;
    const parts = lines[1].trim().split(/\s+/);
    if (parts.length < 6) return null;
    const totalKb = Number(parts[1] || 0);
    const usedKb = Number(parts[2] || 0);
    const availKb = Number(parts[3] || 0);
    const usedPercent = Number(String(parts[4] || "0").replace("%", "")) || 0;
    return {
      mount: parts[5] || "/",
      totalGb: round2(totalKb / 1024 / 1024),
      usedGb: round2(usedKb / 1024 / 1024),
      availableGb: round2(availKb / 1024 / 1024),
      usedPercent: round2(usedPercent)
    };
  } catch {
    return null;
  }
}

async function getGpuMetrics() {
  try {
    const query = "name,utilization.gpu,memory.used,memory.total,temperature.gpu";
    const { stdout } = await execFileAsync("nvidia-smi", [
      `--query-gpu=${query}`,
      "--format=csv,noheader,nounits"
    ]);
    const line = String(stdout || "")
      .trim()
      .split("\n")
      .map((x) => x.trim())
      .find(Boolean);
    if (!line) return null;
    const parts = line.split(",").map((x) => x.trim());
    if (parts.length < 5) return null;
    const name = parts[0];
    const util = Number(parts[1]);
    const memUsed = Number(parts[2]);
    const memTotal = Number(parts[3]);
    const temp = Number(parts[4]);
    const memoryPercent = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
    return {
      name,
      utilizationPercent: Number.isFinite(util) ? round2(util) : null,
      memoryUsedMb: Number.isFinite(memUsed) ? round2(memUsed) : null,
      memoryTotalMb: Number.isFinite(memTotal) ? round2(memTotal) : null,
      memoryPercent: Number.isFinite(memoryPercent) ? round2(memoryPercent) : null,
      temperatureC: Number.isFinite(temp) ? round2(temp) : null
    };
  } catch {
    return null;
  }
}

async function getSystemMetrics() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const usedPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
  const [disk, gpu] = await Promise.all([getDiskUsage(), getGpuMetrics()]);
  return {
    cpu: {
      cores: os.cpus().length,
      loadPercent: getCpuLoadPercent()
    },
    ram: {
      totalGb: round2(totalMem / 1024 / 1024 / 1024),
      usedGb: round2(usedMem / 1024 / 1024 / 1024),
      usedPercent: round2(usedPercent)
    },
    gpu,
    disk,
    updatedAt: new Date().toISOString()
  };
}

function buildPublicEnrichmentSchema(settings) {
  const inputFields = migrateInputFields(settings);
  const enrichmentFields = getEnabledEnrichmentFields(settings);
  const requiredInputFields = inputFields.filter((field) => field.required).map((field) => field.key);
  return {
    inputFields,
    requiredInputFields,
    enrichmentFields: enrichmentFields.map((field) => ({
      key: field.key,
      label: field.label || field.key,
      enabled: field.enabled !== false
    }))
  };
}

function asNullableStringSchema(description = "") {
  return {
    anyOf: [{ type: "string" }, { type: "null" }],
    description
  };
}

function buildOpenApiDocument({ settings, req }) {
  const schema = buildPublicEnrichmentSchema(settings);
  const requestProperties = {};
  for (const field of schema.inputFields) {
    requestProperties[field.key] = {
      type: "string",
      description: field.label || field.key
    };
  }

  const responseProperties = {};
  for (const field of schema.enrichmentFields) {
    responseProperties[field.key] = asNullableStringSchema(field.label || field.key);
  }

  const serverUrl = `${req.protocol}://${req.get("host")}`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Data_Capture_Tool Public API",
      version: "1.0.0",
      description:
        "Dynamic enrichment API. Request/response schemas are generated from current Input Fields and Enrichment Fields."
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: "apiKey",
          in: "header",
          name: "x-api-key"
        }
      },
      schemas: {
        EnrichmentRequest: {
          type: "object",
          additionalProperties: false,
          properties: requestProperties,
          required: schema.requiredInputFields
        },
        EnrichmentResponse: {
          type: "object",
          additionalProperties: false,
          properties: responseProperties
        },
        EnrichmentSchemaResponse: {
          type: "object",
          properties: {
            input_fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  label: { type: "string" },
                  required: { type: "boolean" },
                  placeholder: { type: "string" }
                },
                required: ["key", "label", "required", "placeholder"]
              }
            },
            required_input_fields: {
              type: "array",
              items: { type: "string" }
            },
            enrichment_fields: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  key: { type: "string" },
                  label: { type: "string" },
                  enabled: { type: "boolean" }
                },
                required: ["key", "label", "enabled"]
              }
            }
          },
          required: ["input_fields", "required_input_fields", "enrichment_fields"]
        }
      }
    },
    paths: {
      "/api/public/schema/enrichment": {
        get: {
          summary: "Get dynamic enrichment schema",
          security: [{ ApiKeyAuth: [] }],
          responses: {
            "200": {
              description: "Current dynamic fields",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EnrichmentSchemaResponse" }
                }
              }
            }
          }
        }
      },
      "/api/public/enrich": {
        post: {
          summary: "Run synchronous enrichment",
          security: [{ ApiKeyAuth: [] }],
          parameters: [
            {
              in: "query",
              name: "include_debug",
              schema: { type: "boolean" },
              required: false,
              description: "Set true to include debug payload"
            }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/EnrichmentRequest" }
              }
            }
          },
          responses: {
            "200": {
              description: "Enrichment result",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/EnrichmentResponse" }
                }
              }
            },
            "400": {
              description: "Validation error"
            },
            "401": {
              description: "Unauthorized"
            }
          }
        }
      }
    }
  };
}

function extractApiKeyFromRequest(req) {
  const xKey = String(req.headers["x-api-key"] || "").trim();
  if (xKey) return xKey;
  const auth = String(req.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice(7).trim();
  }
  return "";
}

async function requirePublicApiKey(req, res, next) {
  try {
    const settings = await getSettings();
    const expected = String(settings.publicApiKey || "").trim();
    if (!expected) {
      res.status(503).json({
        ok: false,
        error: "Public API key is not configured. Set `publicApiKey` in settings."
      });
      return;
    }
    const provided = extractApiKeyFromRequest(req);
    if (!provided || provided !== expected) {
      res.status(401).json({
        ok: false,
        error: "Unauthorized. Provide valid `x-api-key` header."
      });
      return;
    }
    req.publicApiSettings = settings;
    next();
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
}

app.get("/api/health", async (_req, res) => {
  const settings = await getSettings();
  res.json({ ok: true, ts: new Date().toISOString(), settings });
});

app.get("/api/system/metrics", async (_req, res) => {
  try {
    const metrics = await getSystemMetrics();
    res.json({ ok: true, ...metrics });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.get("/api/settings", async (_req, res) => {
  const settings = await getSettings();
  res.json(settings);
});

app.put("/api/settings", async (req, res) => {
  try {
    const parsed = settingsSchema.parse(req.body || {});
    const updated = await updateSettings(parsed);
    res.json(updated);
  } catch (error) {
    res.status(400).json({ error: String(error?.message || error) });
  }
});

app.post("/api/enrich", async (req, res) => {
  const requestId = makeApiRequestId("enrich");
  const startedAt = Date.now();
  let settings = null;
  let input = null;
  try {
    const parsed = enrichInputSchema.parse(req.body || {});
    settings = await getSettings();
    input = normalizeInput(parsed, settings);
    validateRequiredInput(input, settings);

    const data = await runEnrichment(input, settings, { includeDebug: true });
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/enrich",
      method: "POST",
      status: 200,
      durationMs: Date.now() - startedAt,
      mode: String(settings.brightDataSerpMode || "request"),
      input,
      evidence: summarizeEvidenceForApiLog(data.debug),
      qwen: summarizeQwenForApiLog(data.debug, data.result),
      includeDebug: false
    });
    res.json(data.result);
  } catch (error) {
    console.error("enrich failed:", error);
    const mapped = mapEnrichmentErrorToHttp(error);
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/enrich",
      method: "POST",
      status: mapped.status,
      durationMs: Date.now() - startedAt,
      mode: settings ? String(settings.brightDataSerpMode || "request") : null,
      input,
      error: mapped.body
    });
    res.status(mapped.status).json(mapped.body);
  }
});

app.post("/api/enrich-debug", async (req, res) => {
  const requestId = makeApiRequestId("enrich_debug");
  const startedAt = Date.now();
  let settings = null;
  let input = null;
  try {
    const parsed = enrichInputSchema.parse(req.body || {});
    settings = await getSettings();
    input = normalizeInput(parsed, settings);
    validateRequiredInput(input, settings);

    const data = await runEnrichment(input, settings, { includeDebug: true });
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/enrich-debug",
      method: "POST",
      status: 200,
      durationMs: Date.now() - startedAt,
      mode: String(settings.brightDataSerpMode || "request"),
      input,
      evidence: summarizeEvidenceForApiLog(data.debug),
      qwen: summarizeQwenForApiLog(data.debug, data.result),
      includeDebug: true
    });
    res.json(data);
  } catch (error) {
    const mapped = mapEnrichmentErrorToHttp(error);
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/enrich-debug",
      method: "POST",
      status: mapped.status,
      durationMs: Date.now() - startedAt,
      mode: settings ? String(settings.brightDataSerpMode || "request") : null,
      input,
      error: mapped.body
    });
    res.status(mapped.status).json(mapped.body);
  }
});

app.post("/api/enrich-debug/start", async (req, res) => {
  const requestId = makeApiRequestId("enrich_debug_start");
  const startedAt = Date.now();
  let settings = null;
  let input = null;
  try {
    const parsed = enrichInputSchema.parse(req.body || {});
    settings = await getSettings();
    input = normalizeInput(parsed, settings);
    validateRequiredInput(input, settings);
    const jobId = makeJobId();

    const job = {
      id: jobId,
      status: "running",
      progress: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      result: null,
      error: null
    };
    enrichJobs.set(jobId, job);
    pushJobLog(job, "Enrichment started", 1);

    (async () => {
      try {
        const data = await runEnrichment(input, settings, {
          includeDebug: true,
          onProgress: (event) => {
            if (typeof event === "string") {
              pushJobLog(job, event);
              return;
            }
            pushJobLog(
              job,
              String(event?.message || "Progress update"),
              Number.isFinite(Number(event?.progress)) ? Number(event.progress) : null
            );
          }
        });
        job.result = data;
        job.status = "completed";
        pushJobLog(job, "Enrichment completed", 100);
        await appendEnrichmentApiLog({
          requestId,
          ts: new Date().toISOString(),
          endpoint: "/api/enrich-debug/start",
          method: "POST",
          status: 200,
          durationMs: Date.now() - startedAt,
          mode: String(settings.brightDataSerpMode || "request"),
          input,
          jobId,
          evidence: summarizeEvidenceForApiLog(data.debug),
          qwen: summarizeQwenForApiLog(data.debug, data.result),
          includeDebug: true
        });
      } catch (error) {
        job.error = String(error?.message || error);
        job.status = "failed";
        pushJobLog(job, `Enrichment failed: ${job.error}`, 100);
        const mapped = mapEnrichmentErrorToHttp(error);
        await appendEnrichmentApiLog({
          requestId,
          ts: new Date().toISOString(),
          endpoint: "/api/enrich-debug/start",
          method: "POST",
          status: mapped.status,
          durationMs: Date.now() - startedAt,
          mode: settings ? String(settings.brightDataSerpMode || "request") : null,
          input,
          jobId,
          includeDebug: true,
          error: mapped.body
        });
      } finally {
        job.updatedAt = new Date().toISOString();
      }
    })();

    res.json({ jobId });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/debug/field-probe", async (req, res) => {
  try {
    const parsed = fieldProbeSchema.parse(req.body || {});
    const settings = await getSettings();
    const input = normalizeInput(parsed, settings);
    validateRequiredInput(input, settings);
    const data = await runFieldProbe({
      input,
      settings,
      field: parsed.field,
      queryTemplate: parsed.queryTemplate || undefined
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

function makeJobId() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pushJobLog(job, message, progress = null) {
  const entry = `[${new Date().toISOString()}] ${message}`;
  job.logs.push(entry);
  if (job.logs.length > 300) job.logs = job.logs.slice(job.logs.length - 300);
  if (Number.isFinite(Number(progress))) {
    job.progress = Math.max(0, Math.min(100, Number(progress)));
  }
  job.updatedAt = new Date().toISOString();
}

app.post("/api/debug/field-probe/start", async (req, res) => {
  try {
    const parsed = fieldProbeSchema.parse(req.body || {});
    const settings = await getSettings();
    const input = normalizeInput(parsed, settings);
    validateRequiredInput(input, settings);
    const jobId = makeJobId();

    const job = {
      id: jobId,
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logs: [],
      result: null,
      error: null
    };
    fieldProbeJobs.set(jobId, job);

    pushJobLog(job, `Probe started for field=${parsed.field}`);

    (async () => {
      try {
        const data = await runFieldProbe({
          input,
          settings,
          field: parsed.field,
          queryTemplate: parsed.queryTemplate || undefined,
          onProgress: (msg) => pushJobLog(job, msg)
        });
        job.result = data;
        job.status = "completed";
        pushJobLog(job, "Probe completed");
      } catch (error) {
        job.error = String(error?.message || error);
        job.status = "failed";
        pushJobLog(job, `Probe failed: ${job.error}`);
      } finally {
        job.updatedAt = new Date().toISOString();
      }
    })();

    res.json({ jobId });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/debug/field-probe/job/:id", (req, res) => {
  const job = fieldProbeJobs.get(String(req.params.id || ""));
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/enrich-debug/job/:id", (req, res) => {
  const job = enrichJobs.get(String(req.params.id || ""));
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/runs", async (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 20)));
  const runs = await prisma.enrichmentRun.findMany({
    take: limit,
    include: {
      evidences: {
        orderBy: { id: "asc" }
      }
    },
    orderBy: { id: "desc" }
  });

  res.json(
    runs.map((run) => ({
      id: run.id,
      company: run.company,
      city: run.city,
      state: run.state,
      website: run.website,
      status: run.status,
      cached: run.usedCache,
      result: JSON.parse(run.resultJson),
      createdAt: run.createdAt,
      errorMessage: run.errorMessage,
      confidences: {
        owner: run.confidenceOwner,
        competitor: run.confidenceCompetitor,
        service: run.confidenceService,
        overall: run.overallConfidence
      },
      evidences: run.evidences
    }))
  );
});

app.get("/api/logs/enrichment", async (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const logs = await readEnrichmentApiLogs(limit);
  res.json({ ok: true, count: logs.length, logs });
});

app.post("/api/logs/enrichment/clear", async (_req, res) => {
  try {
    await clearEnrichmentApiLogs();
    res.json({ ok: true, cleared: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

app.post("/api/debug/run-sample", async (_req, res) => {
  try {
    const settings = await getSettings();
    const data = await runEnrichment(
      {
        company: "Joe's Plumbing",
        city: "Austin",
        state: "TX",
        website: null
      },
      settings
    );
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/debug/model-compatibility-test", async (_req, res) => {
  try {
    const settings = await getSettings();
    const report = await runModelCompatibilityTest({ settings });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

const modelTagsRequestSchema = z.object({
  modelApiBaseUrl: z.string().url().optional(),
  modelApiKey: z.string().optional(),
  modelBasicAuth: z.string().optional(),
  timeoutMs: z.number().int().min(3000).max(60000).optional()
});

app.post("/api/debug/model-tags", async (req, res) => {
  try {
    const parsed = modelTagsRequestSchema.parse(req.body || {});
    const settings = await getSettings();
    const report = await fetchOllamaModelTags({
      modelApiBaseUrl: parsed.modelApiBaseUrl || settings.modelApiBaseUrl,
      modelApiKey: parsed.modelApiKey ?? settings.modelApiKey,
      modelBasicAuth: parsed.modelBasicAuth ?? settings.modelBasicAuth,
      timeoutMs: parsed.timeoutMs || 15000
    });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/public/openapi.json", async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(buildOpenApiDocument({ settings, req }));
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/public/docs", async (req, res) => {
  try {
    const settings = await getSettings();
    const schema = buildPublicEnrichmentSchema(settings);
    const openApiUrl = "/api/public/openapi.json";
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Data_Capture_Tool Public API Docs</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 980px; margin: 24px auto; padding: 0 16px; color: #1f2733; }
    code, pre { background: #f3f4f6; padding: 2px 6px; border-radius: 6px; }
    pre { padding: 12px; overflow: auto; }
    table { border-collapse: collapse; width: 100%; margin: 10px 0 20px; }
    th, td { border: 1px solid #d1d5db; text-align: left; padding: 8px; }
    th { background: #f9fafb; }
  </style>
</head>
<body>
  <h1>Data_Capture_Tool Public API</h1>
  <p>OpenAPI JSON: <a href="${openApiUrl}">${openApiUrl}</a></p>
  <p>Authentication: send API key via <code>x-api-key</code> header (or <code>Authorization: Bearer &lt;key&gt;</code>).</p>
  <h2>Endpoints</h2>
  <ul>
    <li><code>GET /api/public/schema/enrichment</code> - Dynamic input/output schema</li>
    <li><code>POST /api/public/enrich</code> - Synchronous enrichment</li>
  </ul>
  <h2>Required Input Fields</h2>
  <table>
    <thead><tr><th>Key</th><th>Label</th><th>Required</th></tr></thead>
    <tbody>
      ${schema.inputFields
        .map(
          (f) =>
            `<tr><td><code>${f.key}</code></td><td>${f.label || f.key}</td><td>${f.required ? "yes" : "no"}</td></tr>`
        )
        .join("")}
    </tbody>
  </table>
  <h2>Enrichment Output Fields</h2>
  <table>
    <thead><tr><th>Key</th><th>Label</th></tr></thead>
    <tbody>
      ${schema.enrichmentFields
        .map((f) => `<tr><td><code>${f.key}</code></td><td>${f.label || f.key}</td></tr>`)
        .join("")}
    </tbody>
  </table>
  <h2>Example Request</h2>
  <pre>{
  ${schema.inputFields.map((f) => `"${f.key}": ""`).join(",\n  ")}
}</pre>
  <h2>Example cURL</h2>
  <pre>curl -X POST '${req.protocol}://${req.get("host")}/api/public/enrich' \\
  -H 'Content-Type: application/json' \\
  -H 'x-api-key: YOUR_API_KEY' \\
  -d '{"${schema.inputFields[0]?.key || "company"}":"Example"}'</pre>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(html);
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.get("/api/public/schema/enrichment", requirePublicApiKey, async (req, res) => {
  try {
    const settings = req.publicApiSettings || (await getSettings());
    const schema = buildPublicEnrichmentSchema(settings);
    res.json({
      input_fields: schema.inputFields,
      required_input_fields: schema.requiredInputFields,
      enrichment_fields: schema.enrichmentFields
    });
  } catch (error) {
    res.status(500).json({ error: String(error?.message || error) });
  }
});

app.post("/api/public/enrich", requirePublicApiKey, async (req, res) => {
  const requestId = makeApiRequestId("public_enrich");
  const startedAt = Date.now();
  let input = null;
  let settings = null;
  let includeDebug = false;
  try {
    settings = req.publicApiSettings || (await getSettings());
    input = normalizeInput(req.body || {}, settings);
    validateRequiredInput(input, settings);

    includeDebug =
      String(req.query.include_debug || "").toLowerCase() === "true" ||
      Boolean(req.body?.include_debug);
    const data = await runEnrichment(input, settings, { includeDebug: true });
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/public/enrich",
      method: "POST",
      status: 200,
      durationMs: Date.now() - startedAt,
      mode: String(settings.brightDataSerpMode || "request"),
      input,
      evidence: summarizeEvidenceForApiLog(data.debug),
      qwen: summarizeQwenForApiLog(data.debug, data.result),
      includeDebug
    });
    if (includeDebug) {
      res.json(data);
      return;
    }
    res.json(data.result);
  } catch (error) {
    const mapped = mapEnrichmentErrorToHttp(error);
    await appendEnrichmentApiLog({
      requestId,
      ts: new Date().toISOString(),
      endpoint: "/api/public/enrich",
      method: "POST",
      status: mapped.status,
      durationMs: Date.now() - startedAt,
      mode: settings ? String(settings.brightDataSerpMode || "request") : null,
      input,
      includeDebug,
      error: mapped.body
    });
    res.status(mapped.status).json(mapped.body);
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

const port = Number(process.env.PORT || 8787);
const serverRequestTimeoutMs = Math.max(30000, Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 420000));
const serverHeadersTimeoutMs = Math.max(
  serverRequestTimeoutMs + 5000,
  Number(process.env.SERVER_HEADERS_TIMEOUT_MS || serverRequestTimeoutMs + 5000)
);
const serverKeepAliveTimeoutMs = Math.max(5000, Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 65000));
async function start() {
  await ensureDatabaseSchema();
  const server = app.listen(port, () => {
    console.log(`Data_Capture_Tool listening on http://localhost:${port}`);
  });
  server.requestTimeout = serverRequestTimeoutMs;
  server.headersTimeout = serverHeadersTimeoutMs;
  server.keepAliveTimeout = serverKeepAliveTimeoutMs;
}

start().catch((error) => {
  console.error("failed to start:", error);
  process.exit(1);
});

async function shutdown() {
  await browserManager.closeAll();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
