import { prisma } from "./db.js";
import { getDefaultEnrichmentFields, migrateLegacyFields } from "./enrichmentFields.js";
import { getDefaultInputFields, migrateInputFields } from "./inputFields.js";

const DEFAULT_SETTINGS = Object.freeze({
  modelApiBaseUrl: process.env.MODEL_API_BASE_URL || "https://seekers-road-edgar-perry.trycloudflare.com",
  modelName: process.env.MODEL_NAME || "qwen2.5:7b-instruct",
  modelApiKey: process.env.MODEL_API_KEY || "",
  modelBasicAuth: process.env.MODEL_BASIC_AUTH || "",
  publicApiKey: process.env.PUBLIC_API_KEY || "",
  confidenceThreshold: 0.75,
  ownerConfidenceThreshold: 0.6,
  requestTimeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 60000),
  modelRequestTimeoutMs: Number(process.env.MODEL_REQUEST_TIMEOUT_MS || 180000),
  evidenceRequestTimeoutMs: Number(process.env.EVIDENCE_REQUEST_TIMEOUT_MS || 45000),
  modelDisableThinking: true,
  modelReasoningEffort: process.env.MODEL_REASONING_EFFORT || "low",
  ownerMaxTokens: Number(process.env.OWNER_MAX_TOKENS || 40),
  fieldProbeMaxTokens: Number(process.env.FIELD_PROBE_MAX_TOKENS || 80),
  enrichMaxTokens: Number(process.env.ENRICH_MAX_TOKENS || 160),
  cacheTtlHours: 24,
  useCache: true,
  googleSerpOnly: true,
  useBrightDataSerp: true,
  brightDataSerpMode: process.env.BRIGHT_DATA_SERP_MODE || "request",
  brightDataApiToken: process.env.BRIGHT_DATA_API_TOKEN || "",
  brightDataAiModeDatasetId: process.env.BRIGHT_DATA_AI_MODE_DATASET_ID || "gd_mcswdt6z2elth3zqr2",
  brightDataAiModeCountry: process.env.BRIGHT_DATA_AI_MODE_COUNTRY || "",
  brightDataZone: process.env.BRIGHT_DATA_ZONE || "serp_api1",
  brightDataFormat: process.env.BRIGHT_DATA_FORMAT || "raw",
  brightDataDatasetId: process.env.BRIGHT_DATA_DATASET_ID || "gd_mfz5x93lmsjjjylob",
  brightDataDatasetInitialWaitMs: Number(process.env.BRIGHT_DATA_DATASET_INITIAL_WAIT_MS || 15000),
  brightDataDatasetPollIntervalMs: Number(process.env.BRIGHT_DATA_DATASET_POLL_INTERVAL_MS || 30000),
  brightDataDatasetMaxWaitMs: Number(process.env.BRIGHT_DATA_DATASET_MAX_WAIT_MS || 120000),
  brightDataDatasetFallbackToRequest: true,
  profileSerpQueryTemplates: "{{company}} {{city}} {{state}}",
  ownerSerpQueryTemplates:
    "Owner of {{website}} {{city}} {{state}} linkedin\n{{company}} owner {{city}} {{state}} linkedin",
  competitorSerpQueryTemplates:
    "{{company}} competitors {{city}} {{state}}\nbest {{category_or_service}} near {{city}} {{state}}",
  serviceSerpQueryTemplates:
    "{{company}} {{city}} {{state}} services\n{{company}} {{city}} {{state}} what do they do",
  inputFields: getDefaultInputFields(),
  enrichmentFields: getDefaultEnrichmentFields(),
  headed: true,
  rotateProxyPerSite: false,
  proxyRetryCount: 2,
  browserMaxUses: 10,
  proxyList: "",
  allowedSources: ["company_site", "google_maps", "yelp", "linkedin", "bbb"]
});

const SETTINGS_KEY = "data_capture_tool_settings";

export function getDefaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    inputFields: getDefaultInputFields(),
    enrichmentFields: getDefaultEnrichmentFields()
  };
}

export async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return getDefaultSettings();

  let parsed = {};
  try {
    parsed = JSON.parse(row.valueJson);
  } catch {
    parsed = {};
  }

  const merged = {
    ...getDefaultSettings(),
    ...parsed
  };
  merged.inputFields = migrateInputFields(merged);
  merged.enrichmentFields = migrateLegacyFields(merged);
  return merged;
}

export async function updateSettings(partialSettings) {
  const merged = {
    ...(await getSettings()),
    ...partialSettings
  };
  merged.inputFields = migrateInputFields(merged);
  merged.enrichmentFields = migrateLegacyFields(merged);

  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, valueJson: JSON.stringify(merged) },
    update: { valueJson: JSON.stringify(merged) }
  });

  return merged;
}
