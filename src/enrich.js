import { prisma } from "./db.js";
import { collectEvidence, buildPlansFromTemplateText } from "./scrape.js";
import { inferEnrichmentDetailed } from "./model.js";
import { buildNullResultFromFields, migrateLegacyFields } from "./enrichmentFields.js";

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
}

function stableCacheKey(input) {
  return Object.keys(input)
    .sort()
    .map((key) => `${key}:${String(input[key] || "").trim().toLowerCase()}`)
    .join("||");
}

function shorten(text, maxLen = 1300) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function buildEvidenceLines(evidence, options = {}) {
  const maxSources = Number(options.maxSources || 6);
  const snippetMax = Number(options.snippetMax || 1300);
  return evidence
    .slice(0, maxSources)
    .map((item, idx) => {
      return `Source ${idx + 1} | ${item.sourceType} | field=${item.field || "unknown"} | ${item.url}\n${shorten(
        item.snippet,
        snippetMax
      )}`;
    })
    .join("\n\n");
}

function toNumberOrZero(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.min(1, Math.max(0, num)) : 0;
}

function normalizeTopService(value) {
  const raw = normalizeString(value);
  if (!raw) return null;

  let text = raw;
  text = text.split(",")[0];
  text = text.split("/")[0];
  text = text.split(" and ")[0];
  text = text.split(" & ")[0];
  text = text.split(" - ")[0];
  text = text.replace(/\s+/g, " ").trim();

  if (!text) return null;
  const words = text.split(" ").filter(Boolean);
  if (words.length > 5) {
    text = words.slice(0, 5).join(" ");
  }

  return text || null;
}

function getModelTimeoutMs(settings) {
  return Number(settings.modelRequestTimeoutMs || settings.requestTimeoutMs || 180000);
}

function renderPromptTemplate(template, { input, evidenceLines, field, fieldValues = {} }) {
  const base = String(template || "");
  const replacements = {
    company: input.company || "",
    city: input.city || "",
    state: input.state || "",
    website: input.website || "",
    evidenceLines: evidenceLines || "",
    fieldKey: field.key,
    fieldLabel: field.label || field.key
  };

  let out = base;
  out = out.replace(/\$\{\s*input\.([a-zA-Z0-9_]+)\s*\}/g, (_m, key) => {
    const value = input?.[key];
    return value === null || value === undefined ? "" : String(value);
  });
  out = out.replace(/\$\{\s*(fields|results)\.([a-zA-Z0-9_]+)\s*\}/g, (_m, _scope, key) => {
    const value = fieldValues?.[key];
    return value === null || value === undefined ? "" : String(value);
  });
  out = out.replace(/\$\{\s*evidenceLines\s*\}/g, replacements.evidenceLines);
  out = out.replace(/\$\{\s*field\.key\s*\}/g, replacements.fieldKey);
  out = out.replace(/\$\{\s*field\.label\s*\}/g, replacements.fieldLabel);

  out = out.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (match, key) => {
    if (key === "evidenceLines") return replacements.evidenceLines;
    if (key === "field_key") return replacements.fieldKey;
    if (key === "field_label") return replacements.fieldLabel;
    if (Object.prototype.hasOwnProperty.call(input || {}, key)) {
      const value = input[key];
      return value === null || value === undefined ? "" : String(value);
    }
    if (Object.prototype.hasOwnProperty.call(fieldValues || {}, key)) {
      const value = fieldValues[key];
      return value === null || value === undefined ? "" : String(value);
    }
    return match;
  });
  out = out.replace(/{{\s*evidenceLines\s*}}/g, replacements.evidenceLines);
  out = out.replace(/{{\s*field_key\s*}}/g, replacements.fieldKey);
  out = out.replace(/{{\s*field_label\s*}}/g, replacements.fieldLabel);
  out = out.replace(/\$\{\s*(fields|results|input)\.[^}]+\}/g, "");

  return out;
}

function buildDefaultFieldPrompt({ input, field, evidence }) {
  const evidenceLines = buildEvidenceLines(evidence, { maxSources: 4, snippetMax: 1600 });
  return buildDefaultFieldPromptFromEvidenceLines({ input, field, evidenceLines });
}

function buildDefaultFieldPromptFromEvidenceLines({ input, field, evidenceLines }) {
  const confidenceKey = `${field.key}_confidence`;

  return `Find ${field.label || field.key} from provided search evidence only.

Input:
Company: ${input.company}
City: ${input.city}
State: ${input.state}
Website: ${input.website || ""}

Rules:
- Return ONLY valid JSON. No markdown.
- Do not guess.
- Use null when unknown.

Evidence:
${evidenceLines}

Return exactly:
{
  "${field.key}": null,
  "${confidenceKey}": 0
}`;
}

function buildFieldPromptFromEvidenceLines({ input, field, evidenceLines, fieldValues = {} }) {
  if (!field.promptTemplate) {
    return buildDefaultFieldPromptFromEvidenceLines({ input, field, evidenceLines });
  }
  return renderPromptTemplate(field.promptTemplate, { input, evidenceLines, field, fieldValues });
}

function buildFieldPrompt({ input, field, evidence, fieldValues = {} }) {
  const evidenceLines = buildEvidenceLines(evidence, { maxSources: 4, snippetMax: 1600 });
  return buildFieldPromptFromEvidenceLines({ input, field, evidenceLines, fieldValues });
}

function extractFieldFromParsed(parsed, fieldKey) {
  const value = normalizeString(parsed?.[fieldKey]);
  const confidenceKey = `${fieldKey}_confidence`;
  const rawConfidence = parsed?.[confidenceKey];
  const confidence = value ? (rawConfidence === undefined ? 1 : toNumberOrZero(rawConfidence)) : 0;
  return { value, confidence, confidenceKey };
}

function getFieldThreshold(field, settings) {
  if (Number.isFinite(Number(field.confidenceThreshold))) {
    return Math.min(1, Math.max(0, Number(field.confidenceThreshold)));
  }
  return Math.min(1, Math.max(0, Number(settings.confidenceThreshold ?? 0.75)));
}

function getFieldMaxTokens(field, settings) {
  if (Number.isFinite(Number(field.maxTokens)) && Number(field.maxTokens) > 0) {
    return Number(field.maxTokens);
  }
  return Number(settings.fieldProbeMaxTokens || 80);
}

function buildFieldSpecificEvidence(evidence, fieldKey) {
  const specific = evidence.filter((item) => item.field === fieldKey);
  const shared = evidence.filter((item) => item.field === "business_profile");
  if (!specific.length) return shared.slice(0, 6);
  return [...specific, ...shared].slice(0, 8);
}

function buildEvidenceForPass(fieldEvidence, passType) {
  const out = [];
  for (const item of fieldEvidence || []) {
    const aioText = normalizeString(item?.debug?.aioText);
    const compactOrganic = normalizeString(item?.debug?.compactOrganicPreview);
    const aiAnswerText = normalizeString(item?.debug?.aiAnswerText);
    const aiAnswerMarkdown = normalizeString(item?.debug?.aiAnswerMarkdown);
    const aiHtmlText = normalizeString(item?.debug?.aiAnswerHtmlText);
    let snippet = null;

    if (passType === "aio") {
      if (!aioText) continue;
      snippet = `AIO text:\n${aioText}`;
    } else if (passType === "ai_answer") {
      if (!aiAnswerText && !aiAnswerMarkdown) continue;
      snippet = `AI answer text:\n${aiAnswerText || ""}\n\nAI answer markdown:\n${aiAnswerMarkdown || ""}`;
    } else if (passType === "ai_html") {
      if (!aiHtmlText) continue;
      snippet = `AI answer html text fallback:\n${aiHtmlText}`;
    } else if (compactOrganic) {
      snippet = `Top organic results (compact):\n${compactOrganic}`;
    } else {
      snippet = item?.snippet || "";
    }

    out.push({
      ...item,
      snippet
    });
  }
  return out;
}

function summarizeAioForEvidence(evidenceList) {
  const items = Array.isArray(evidenceList) ? evidenceList : [];
  const withAio = items.filter((item) => String(item?.debug?.aioText || "").trim().length > 0);
  const withAiAnswer = items.filter(
    (item) =>
      String(item?.debug?.aiAnswerText || "").trim().length > 0 ||
      String(item?.debug?.aiAnswerMarkdown || "").trim().length > 0 ||
      String(item?.debug?.aiAnswerHtmlText || "").trim().length > 0
  );
  const totalAioChars = withAio.reduce(
    (sum, item) => sum + String(item?.debug?.aioText || "").trim().length,
    0
  );
  const totalAiAnswerChars = withAiAnswer.reduce(
    (sum, item) =>
      sum +
      String(item?.debug?.aiAnswerText || "").trim().length +
      String(item?.debug?.aiAnswerMarkdown || "").trim().length +
      String(item?.debug?.aiAnswerHtmlText || "").trim().length,
    0
  );
  return {
    total: items.length,
    withAio: withAio.length,
    totalAioChars,
    withAiAnswer: withAiAnswer.length,
    totalAiAnswerChars
  };
}

function shouldUseBrightDataAioTwoPass(settings) {
  return (
    Boolean(settings.useBrightDataSerp) &&
    String(settings.brightDataSerpMode || "request").toLowerCase() === "dataset"
  );
}

function isBrightDataAiMode(settings) {
  return (
    Boolean(settings.useBrightDataSerp) &&
    String(settings.brightDataSerpMode || "request").toLowerCase() === "ai_mode"
  );
}

async function runFieldExtractionPass({
  settings,
  input,
  field,
  fieldValues,
  evidenceForPrompt,
  threshold,
  passName
}) {
  const prompt = buildFieldPrompt({
    input,
    field,
    evidence: evidenceForPrompt,
    fieldValues
  });

  try {
    const model = await inferEnrichmentDetailed({
      settings,
      prompt,
      timeoutMs: getModelTimeoutMs(settings),
      options: { maxTokens: getFieldMaxTokens(field, settings) }
    });

    const extracted = extractFieldFromParsed(model.parsed, field.key);
    let value = extracted.value;
    if (field.key === "top_service") {
      value = normalizeTopService(value);
    }

    const gatedValue = extracted.confidence >= threshold ? value : null;
    const shouldRetry = !value || extracted.confidence < threshold;
    return {
      ok: true,
      passName,
      prompt,
      evidenceCount: evidenceForPrompt.length,
      value,
      confidence: extracted.confidence,
      gatedValue,
      shouldRetry,
      confidenceKey: extracted.confidenceKey,
      model
    };
  } catch (error) {
    return {
      ok: false,
      passName,
      prompt,
      evidenceCount: evidenceForPrompt.length,
      value: null,
      confidence: 0,
      gatedValue: null,
      shouldRetry: true,
      confidenceKey: `${field.key}_confidence`,
      error: String(error?.message || error),
      model: {
        parsed: null,
        rawResponseText: "",
        rawResponseJson: null,
        endpointUrl: null,
        attempts: Array.isArray(error?.attempts) ? error.attempts : [],
        payload: null
      }
    };
  }
}

function average(values) {
  if (!values.length) return 0;
  return Number((values.reduce((sum, item) => sum + item, 0) / values.length).toFixed(4));
}

function emitProgress(options, message, progress = null, extra = {}) {
  if (typeof options?.onProgress !== "function") return;
  options.onProgress({
    message,
    progress,
    ...extra
  });
}

function makeEvidenceProgressReporter(options, fieldKey = null) {
  return (message) => {
    emitProgress(options, `Evidence: ${String(message || "")}`, null, {
      stage: "evidence_log",
      field: fieldKey
    });
  };
}

function buildFieldTemplateVars(input, priorFieldValues) {
  const out = {};
  for (const [key, value] of Object.entries(input || {})) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  for (const [key, value] of Object.entries(priorFieldValues || {})) {
    out[key] = value === null || value === undefined ? "" : String(value);
  }
  return out;
}

async function findCachedRun(cacheKey, settings) {
  if (!settings.useCache) return null;
  const ttlMs = Math.max(1, Number(settings.cacheTtlHours || 24)) * 3600 * 1000;
  const cutoff = new Date(Date.now() - ttlMs);

  return prisma.enrichmentRun.findFirst({
    where: {
      cacheKey,
      status: "success",
      createdAt: { gte: cutoff }
    },
    include: {
      evidences: true
    },
    orderBy: {
      createdAt: "desc"
    }
  });
}

export async function runEnrichment(input, settings, options = {}) {
  const cleanInput = Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, value === null || value === undefined ? "" : String(value).trim()])
  );
  cleanInput.company = String(cleanInput.company || "").trim();
  cleanInput.city = String(cleanInput.city || "").trim();
  cleanInput.state = String(cleanInput.state || "").trim();
  cleanInput.website = normalizeString(cleanInput.website);

  const fields = migrateLegacyFields(settings).filter((field) => field.enabled);
  const nullResult = buildNullResultFromFields(fields);

  const cacheKey = stableCacheKey(cleanInput);
  const cached = await findCachedRun(cacheKey, settings);
  if (cached) {
    emitProgress(options, "Cache hit. Returning cached result.", 100, { stage: "cache" });
    return {
      result: JSON.parse(cached.resultJson),
      evidences: cached.evidences,
      meta: {
        runId: cached.id,
        cached: true,
        confidences: {
          ownerConfidence: cached.confidenceOwner,
          competitorConfidence: cached.confidenceCompetitor,
          serviceConfidence: cached.confidenceService,
          overallConfidence: cached.overallConfidence
        },
        fieldConfidences: {}
      },
      debug: options.includeDebug
        ? {
            cached: true,
            fieldDebug: [],
            prompt: null,
            modelRawResponseText: null,
            modelRawResponseJson: null,
            modelEndpoint: null,
            modelAttempts: [],
            modelParsedBeforeThreshold: null,
            evidenceDebug: []
          }
        : undefined
    };
  }

  const startedAt = new Date();
  const run = await prisma.enrichmentRun.create({
    data: {
      cacheKey,
      company: cleanInput.company,
      city: cleanInput.city,
      state: cleanInput.state,
      website: cleanInput.website,
      status: "running",
      requestPayloadJson: JSON.stringify(cleanInput),
      resultJson: JSON.stringify(nullResult),
      startedAt
    }
  });

  try {
    emitProgress(options, "Starting enrichment run", 5, { stage: "start" });
    emitProgress(
      options,
      `Config: brightdata=${Boolean(settings.useBrightDataSerp)} mode=${String(
        settings.brightDataSerpMode || "request"
      )} dataset_wait=${Number(settings.brightDataDatasetInitialWaitMs || 15000)}ms poll=${Number(
        settings.brightDataDatasetPollIntervalMs || 30000
      )}ms max_wait=${Number(settings.brightDataDatasetMaxWaitMs || 120000)}ms fallback=${Boolean(
        settings.brightDataDatasetFallbackToRequest
      )}`,
      6,
      { stage: "config" }
    );
    const result = {};
    const rawResult = {};
    const fieldConfidences = {};
    const fieldDebug = [];
    const allEvidence = [];
    const priorFieldValues = {};

    const sharedOverrideEvidence = Array.isArray(options.planOverride)
      ? await collectEvidence(cleanInput, settings, {
          planOverride: options.planOverride,
          onProgress: makeEvidenceProgressReporter(options, "all")
        })
      : null;

    for (const [fieldIndex, field] of fields.entries()) {
      const totalFields = Math.max(1, fields.length);
      const fieldStartProgress = Math.min(90, 10 + Math.floor((fieldIndex / totalFields) * 75));
      emitProgress(
        options,
        `Field ${fieldIndex + 1}/${totalFields}: collecting evidence for ${field.key}`,
        fieldStartProgress,
        { stage: "field_collect", field: field.key, index: fieldIndex + 1, total: totalFields }
      );
      const fieldTemplateVars = buildFieldTemplateVars(cleanInput, priorFieldValues);
      const useAiMode = isBrightDataAiMode(settings);

      const profilePlans = buildPlansFromTemplateText({
        input: cleanInput,
        templateText: settings.profileSerpQueryTemplates || "{{company}} {{city}} {{state}}",
        field: "business_profile",
        type: "google_serp_profile",
        extraVars: fieldTemplateVars
      });
      const fieldPlans = buildPlansFromTemplateText({
        input: cleanInput,
        templateText: field.queryTemplates || "{{company}} {{city}} {{state}}",
        field: field.key,
        type: `google_serp_${field.key}`,
        extraVars: fieldTemplateVars
      });

      const collectedForField = sharedOverrideEvidence
        ? sharedOverrideEvidence
        : await collectEvidence(cleanInput, settings, {
            planOverride: useAiMode ? [...fieldPlans] : [...profilePlans, ...fieldPlans],
            onProgress: makeEvidenceProgressReporter(options, field.key)
          });
      if (sharedOverrideEvidence) {
        if (!allEvidence.length) allEvidence.push(...collectedForField);
      } else {
        allEvidence.push(...collectedForField);
      }

      const fieldEvidence = buildFieldSpecificEvidence(collectedForField, field.key);
      const aioSummary = summarizeAioForEvidence(fieldEvidence);
      emitProgress(
        options,
        `Field ${fieldIndex + 1}/${totalFields}: evidence summary for ${field.key} sources=${aioSummary.total} aio_sources=${aioSummary.withAio} aio_chars=${aioSummary.totalAioChars} ai_answer_sources=${aioSummary.withAiAnswer} ai_answer_chars=${aioSummary.totalAiAnswerChars}`,
        Math.min(95, fieldStartProgress + 3),
        { stage: "field_evidence_summary", field: field.key }
      );
      emitProgress(
        options,
        `Field ${fieldIndex + 1}/${totalFields}: sending prompt for ${field.key}`,
        Math.min(95, fieldStartProgress + 5),
        { stage: "field_model", field: field.key, index: fieldIndex + 1, total: totalFields }
      );
      const threshold = getFieldThreshold(field, settings);
      const useTwoPass = shouldUseBrightDataAioTwoPass(settings);
      const useAiModePass = isBrightDataAiMode(settings);
      const aioEvidence = buildEvidenceForPass(fieldEvidence, "aio");
      const organicEvidence = buildEvidenceForPass(fieldEvidence, "organic");
      const aiAnswerEvidence = buildEvidenceForPass(fieldEvidence, "ai_answer");
      const aiHtmlEvidence = buildEvidenceForPass(fieldEvidence, "ai_html");
      let passPlan = [{ name: "organic", evidence: organicEvidence }];
      if (useTwoPass && aioEvidence.length) {
        passPlan = [
          { name: "aio", evidence: aioEvidence },
          { name: "organic", evidence: organicEvidence }
        ];
      } else if (useAiModePass) {
        passPlan = [
          { name: "ai_answer", evidence: aiAnswerEvidence.length ? aiAnswerEvidence : fieldEvidence },
          { name: "ai_html", evidence: aiHtmlEvidence.length ? aiHtmlEvidence : fieldEvidence }
        ];
      }

      const passDebug = [];
      let selectedPass = null;
      for (const pass of passPlan) {
        emitProgress(
          options,
          `Field ${fieldIndex + 1}/${totalFields}: qwen pass=${pass.name} for ${field.key}`,
          Math.min(96, fieldStartProgress + 8),
          { stage: "field_model_pass", field: field.key, pass: pass.name }
        );
        const passResult = await runFieldExtractionPass({
          settings,
          input: cleanInput,
          field,
          fieldValues: priorFieldValues,
          evidenceForPrompt: pass.evidence.length ? pass.evidence : fieldEvidence,
          threshold,
          passName: pass.name
        });
        passDebug.push(passResult);
        selectedPass = passResult;
        emitProgress(
          options,
          `Field ${fieldIndex + 1}/${totalFields}: pass=${pass.name} value=${passResult.value ? "yes" : "no"} confidence=${Number(
            passResult.confidence || 0
          ).toFixed(2)} retry=${passResult.shouldRetry ? "yes" : "no"}`,
          Math.min(96, fieldStartProgress + 10),
          { stage: "field_model_pass_result", field: field.key, pass: pass.name }
        );
        if (!passResult.shouldRetry) break;
      }

      const chosen = selectedPass || {
        value: null,
        confidence: 0,
        gatedValue: null,
        confidenceKey: `${field.key}_confidence`,
        model: {
          payload: null,
          rawResponseText: "",
          rawResponseJson: null,
          endpointUrl: null,
          attempts: [],
          parsed: null
        }
      };
      const value = chosen.value;
      const gatedValue = chosen.gatedValue;
      const chainedValue = gatedValue || value || "";

      rawResult[field.key] = value;
      rawResult[chosen.confidenceKey] = chosen.confidence;
      result[field.key] = gatedValue;
      fieldConfidences[field.key] = chosen.confidence;
      priorFieldValues[field.key] = chainedValue;
      emitProgress(
        options,
        `Field ${fieldIndex + 1}/${totalFields}: ${field.key} ${gatedValue ? "found" : "not found"}`,
        Math.min(96, fieldStartProgress + 12),
        {
          stage: "field_done",
          field: field.key,
          index: fieldIndex + 1,
          total: totalFields,
          found: Boolean(gatedValue)
        }
      );

      fieldDebug.push({
        key: field.key,
        label: field.label,
        threshold,
        prompt: chosen.prompt || null,
        evidenceCount: fieldEvidence.length,
        rawValue: value,
        confidence: chosen.confidence,
        gatedValue,
        chainedValue,
        modelRequestPayload: chosen.model?.payload || null,
        modelRawResponseText: chosen.model?.rawResponseText || "",
        modelRawResponseJson: chosen.model?.rawResponseJson || null,
        modelEndpoint: chosen.model?.endpointUrl || null,
        modelAttempts: chosen.model?.attempts || [],
        modelParsed: chosen.model?.parsed || null,
        passDebug: passDebug.map((pass) => ({
          passName: pass.passName,
          ok: pass.ok,
          shouldRetry: pass.shouldRetry,
          prompt: pass.prompt,
          evidenceCount: pass.evidenceCount,
          rawValue: pass.value,
          confidence: pass.confidence,
          gatedValue: pass.gatedValue,
          error: pass.error || null,
          modelRequestPayload: pass.model?.payload || null,
          modelRawResponseText: pass.model?.rawResponseText || "",
          modelRawResponseJson: pass.model?.rawResponseJson || null,
          modelEndpoint: pass.model?.endpointUrl || null,
          modelAttempts: pass.model?.attempts || [],
          modelParsed: pass.model?.parsed || null
        })),
        aioSummary
      });
    }

    const ownerConfidence = toNumberOrZero(fieldConfidences.owner_firstname);
    const competitorConfidence = toNumberOrZero(fieldConfidences.closest_competitor);
    const serviceConfidence = toNumberOrZero(fieldConfidences.top_service);
    const overallConfidence = average(Object.values(fieldConfidences).map((value) => toNumberOrZero(value)));

    await prisma.$transaction([
      prisma.evidence.createMany({
        data: allEvidence.map((ev) => ({
          runId: run.id,
          sourceType: ev.sourceType,
          url: ev.url,
          snippet: ev.snippet,
          confidence: null,
          field: ev.field || null
        }))
      }),
      prisma.enrichmentRun.update({
        where: { id: run.id },
        data: {
          status: "success",
          usedCache: false,
          resultJson: JSON.stringify(result),
          confidenceOwner: ownerConfidence,
          confidenceCompetitor: competitorConfidence,
          confidenceService: serviceConfidence,
          overallConfidence,
          completedAt: new Date()
        }
      })
    ]);
    emitProgress(options, "Saving run and finishing", 99, { stage: "save" });

    const firstDebug = fieldDebug[0] || null;
    emitProgress(options, "Enrichment completed", 100, { stage: "done" });

    return {
      result,
      evidences: allEvidence,
      meta: {
        runId: run.id,
        cached: false,
        confidences: {
          ownerConfidence,
          competitorConfidence,
          serviceConfidence,
          overallConfidence
        },
        fieldConfidences
      },
      debug: options.includeDebug
        ? {
            cached: false,
            fieldDebug,
            prompt: firstDebug?.prompt || null,
            modelRequestPayload: firstDebug?.modelRequestPayload || null,
            modelRawResponseText: firstDebug?.modelRawResponseText || null,
            modelRawResponseJson: firstDebug?.modelRawResponseJson || null,
            modelEndpoint: firstDebug?.modelEndpoint || null,
            modelAttempts: firstDebug?.modelAttempts || [],
            modelParsedBeforeThreshold: rawResult,
            evidenceDebug: allEvidence.map((ev) => ({
              sourceType: ev.sourceType,
              field: ev.field || null,
              query: ev.query || null,
              queryTemplate: ev.queryTemplate || null,
              url: ev.url,
              provider: ev.debug?.provider || null,
              mode: ev.debug?.mode || null,
              fallbackUsed: Boolean(ev.debug?.fallbackUsed),
              timeline: Array.isArray(ev.debug?.timeline) ? ev.debug.timeline : [],
              aioText: ev.debug?.aioText || null,
              aiAnswerText: ev.debug?.aiAnswerText || null,
              aiAnswerMarkdown: ev.debug?.aiAnswerMarkdown || null,
              aiAnswerHtmlText: ev.debug?.aiAnswerHtmlText || null,
              compactOrganicPreview: ev.debug?.compactOrganicPreview || null,
              rawResponsePreview: ev.debug?.rawResponsePreview || null,
              topLinks: ev.debug?.topLinks || []
            }))
          }
        : undefined
    };
  } catch (error) {
    emitProgress(options, `Enrichment failed: ${String(error?.message || error)}`, 100, {
      stage: "error"
    });
    await prisma.enrichmentRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        errorMessage: String(error?.message || error),
        completedAt: new Date()
      }
    });

    throw error;
  }
}

export async function runFieldProbe({ input, settings, field, queryTemplate, onProgress }) {
  const cleanInput = Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, value === null || value === undefined ? "" : String(value).trim()])
  );
  cleanInput.company = String(cleanInput.company || "").trim();
  cleanInput.city = String(cleanInput.city || "").trim();
  cleanInput.state = String(cleanInput.state || "").trim();
  cleanInput.website = normalizeString(cleanInput.website);

  const fields = migrateLegacyFields(settings);
  const enabledFields = fields.filter((item) => item.enabled !== false);
  const useAiMode = isBrightDataAiMode(settings);
  const selectedField =
    fields.find((item) => item.key === field) ||
    {
      key: String(field || "field").trim(),
      label: String(field || "field").trim(),
      enabled: true,
      queryTemplates: "{{company}} {{city}} {{state}}",
      promptTemplate: "",
      confidenceThreshold: Number(settings.confidenceThreshold ?? 0.75),
      maxTokens: Number(settings.fieldProbeMaxTokens || 80)
    };

  const selectedIndex = enabledFields.findIndex((item) => item.key === selectedField.key);
  const priorFieldValues = {};
  const priorFieldDebug = [];

  if (selectedIndex > 0) {
    for (const priorField of enabledFields.slice(0, selectedIndex)) {
      const priorVars = buildFieldTemplateVars(cleanInput, priorFieldValues);
      const priorProfilePlans = buildPlansFromTemplateText({
        input: cleanInput,
        templateText: settings.profileSerpQueryTemplates || "{{company}} {{city}} {{state}}",
        field: "business_profile",
        type: "google_serp_profile",
        extraVars: priorVars
      });
      const priorFieldPlans = buildPlansFromTemplateText({
        input: cleanInput,
        templateText: priorField.queryTemplates || "{{company}} {{city}} {{state}}",
        field: priorField.key,
        type: `google_serp_${priorField.key}`,
        extraVars: priorVars
      });
      const priorPlans = useAiMode ? [...priorFieldPlans] : [...priorProfilePlans, ...priorFieldPlans];

      if (onProgress) onProgress(`Resolving prior field dependency: ${priorField.key}`);
      const priorEvidence = await collectEvidence(cleanInput, settings, {
        planOverride: priorPlans,
        onProgress
      });
      const priorFieldEvidence = buildFieldSpecificEvidence(priorEvidence, priorField.key);
      const priorThreshold = getFieldThreshold(priorField, settings);
      const useTwoPass = shouldUseBrightDataAioTwoPass(settings);
      const useAiModePass = isBrightDataAiMode(settings);
      const priorAioEvidence = buildEvidenceForPass(priorFieldEvidence, "aio");
      const priorOrganicEvidence = buildEvidenceForPass(priorFieldEvidence, "organic");
      const priorAiAnswerEvidence = buildEvidenceForPass(priorFieldEvidence, "ai_answer");
      const priorAiHtmlEvidence = buildEvidenceForPass(priorFieldEvidence, "ai_html");
      let priorPassPlan = [{ name: "organic", evidence: priorOrganicEvidence }];
      if (useTwoPass && priorAioEvidence.length) {
        priorPassPlan = [
          { name: "aio", evidence: priorAioEvidence },
          { name: "organic", evidence: priorOrganicEvidence }
        ];
      } else if (useAiModePass) {
        priorPassPlan = [
          { name: "ai_answer", evidence: priorAiAnswerEvidence.length ? priorAiAnswerEvidence : priorFieldEvidence },
          { name: "ai_html", evidence: priorAiHtmlEvidence.length ? priorAiHtmlEvidence : priorFieldEvidence }
        ];
      }

      let priorSelected = null;
      const priorPassDebug = [];
      for (const pass of priorPassPlan) {
        const passResult = await runFieldExtractionPass({
          settings,
          input: cleanInput,
          field: priorField,
          fieldValues: priorFieldValues,
          evidenceForPrompt: pass.evidence.length ? pass.evidence : priorFieldEvidence,
          threshold: priorThreshold,
          passName: pass.name
        });
        priorPassDebug.push(passResult);
        priorSelected = passResult;
        if (!passResult.shouldRetry) break;
      }

      const priorValue = priorSelected?.value || null;
      const priorGated = priorSelected?.gatedValue || null;
      const priorChained = priorGated || priorValue || "";
      priorFieldValues[priorField.key] = priorChained;
      priorFieldDebug.push({
        key: priorField.key,
        value: priorValue,
        gatedValue: priorGated,
        chainedValue: priorChained,
        confidence: Number(priorSelected?.confidence || 0),
        passDebug: priorPassDebug.map((pass) => ({
          passName: pass.passName,
          ok: pass.ok,
          shouldRetry: pass.shouldRetry,
          rawValue: pass.value,
          confidence: pass.confidence,
          gatedValue: pass.gatedValue,
          error: pass.error || null
        }))
      });
    }
  }

  const probeTemplateVars = buildFieldTemplateVars(cleanInput, priorFieldValues);
  const templateText = queryTemplate || selectedField.queryTemplates || "{{company}} {{city}} {{state}}";
  const probeProfilePlans = buildPlansFromTemplateText({
    input: cleanInput,
    templateText: settings.profileSerpQueryTemplates || "{{company}} {{city}} {{state}}",
    field: "business_profile",
    type: "google_serp_profile",
    extraVars: probeTemplateVars
  });
  const probeFieldPlans = buildPlansFromTemplateText({
    input: cleanInput,
    templateText,
    field: selectedField.key,
    type: `google_serp_${selectedField.key}`,
    extraVars: probeTemplateVars
  });
  const planOverride = useAiMode ? [...probeFieldPlans] : [...probeProfilePlans, ...probeFieldPlans];

  if (onProgress) {
    onProgress(
      `Timeouts: model=${String(
        Number(settings.modelRequestTimeoutMs || settings.requestTimeoutMs || 180000)
      )}ms evidence=${String(
        Number(
          settings.evidenceRequestTimeoutMs ||
            Math.max(5000, Number(settings.requestTimeoutMs || 60000) / 3)
        )
      )}ms`
    );
  }
  if (onProgress) onProgress(`Built plan with ${planOverride.length} query(ies)`);

  const evidence = await collectEvidence(cleanInput, settings, {
    planOverride,
    onProgress
  });
  if (onProgress) onProgress(`Evidence collected: ${evidence.length} item(s)`);

  const fieldEvidence = buildFieldSpecificEvidence(evidence, selectedField.key);
  const aioSummary = summarizeAioForEvidence(fieldEvidence);
  if (onProgress) {
    onProgress(
      `Field evidence summary: field=${selectedField.key} sources=${aioSummary.total} aio_sources=${aioSummary.withAio} aio_chars=${aioSummary.totalAioChars} ai_answer_sources=${aioSummary.withAiAnswer} ai_answer_chars=${aioSummary.totalAiAnswerChars}`
    );
  }
  const threshold = getFieldThreshold(selectedField, settings);
  const useTwoPass = shouldUseBrightDataAioTwoPass(settings);
  const useAiModePass = isBrightDataAiMode(settings);
  const aioEvidence = buildEvidenceForPass(fieldEvidence, "aio");
  const organicEvidence = buildEvidenceForPass(fieldEvidence, "organic");
  const aiAnswerEvidence = buildEvidenceForPass(fieldEvidence, "ai_answer");
  const aiHtmlEvidence = buildEvidenceForPass(fieldEvidence, "ai_html");
  let passPlan = [{ name: "organic", evidence: organicEvidence }];
  if (useTwoPass && aioEvidence.length) {
    passPlan = [
      { name: "aio", evidence: aioEvidence },
      { name: "organic", evidence: organicEvidence }
    ];
  } else if (useAiModePass) {
    passPlan = [
      { name: "ai_answer", evidence: aiAnswerEvidence.length ? aiAnswerEvidence : fieldEvidence },
      { name: "ai_html", evidence: aiHtmlEvidence.length ? aiHtmlEvidence : fieldEvidence }
    ];
  }

  let selectedPass = null;
  const passDebug = [];
  for (const pass of passPlan) {
    if (onProgress) onProgress(`Sending prompt to Qwen (pass=${pass.name})`);
    const passResult = await runFieldExtractionPass({
      settings,
      input: cleanInput,
      field: selectedField,
      fieldValues: priorFieldValues,
      evidenceForPrompt: pass.evidence.length ? pass.evidence : fieldEvidence,
      threshold,
      passName: pass.name
    });
    passDebug.push(passResult);
    selectedPass = passResult;
    if (onProgress) {
      onProgress(
        `Received response from Qwen (pass=${pass.name}) value=${passResult.value ? "yes" : "no"} confidence=${Number(
          passResult.confidence || 0
        ).toFixed(2)} retry=${passResult.shouldRetry ? "yes" : "no"}`
      );
    }
    if (!passResult.shouldRetry) break;
  }

  const extracted = {
    value: selectedPass?.value || null,
    confidence: Number(selectedPass?.confidence || 0)
  };

  return {
    field: selectedField.key,
    queryTemplate: queryTemplate || null,
    threshold,
    priorFieldValues,
    priorFieldDebug,
    extracted: {
      value: extracted.value,
      confidence: extracted.confidence
    },
    prompt: selectedPass?.prompt || null,
    passDebug: passDebug.map((pass) => ({
      passName: pass.passName,
      ok: pass.ok,
      shouldRetry: pass.shouldRetry,
      prompt: pass.prompt,
      evidenceCount: pass.evidenceCount,
      rawValue: pass.value,
      confidence: pass.confidence,
      gatedValue: pass.gatedValue,
      error: pass.error || null,
      modelRequestPayload: pass.model?.payload || null,
      modelRawResponseText: pass.model?.rawResponseText || "",
      modelRawResponseJson: pass.model?.rawResponseJson || null,
      modelEndpoint: pass.model?.endpointUrl || null,
      modelAttempts: pass.model?.attempts || [],
      modelParsed: pass.model?.parsed || null
    })),
    aioSummary,
    evidence,
    model: {
      parsed: selectedPass?.model?.parsed || null,
      rawResponseText: selectedPass?.model?.rawResponseText || "",
      rawResponseJson: selectedPass?.model?.rawResponseJson || null,
      endpoint: selectedPass?.model?.endpointUrl || null,
      attempts: selectedPass?.model?.attempts || [],
      requestPayload: selectedPass?.model?.payload || null
    }
  };
}
