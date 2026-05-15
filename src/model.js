function trimTrailingSlash(value) {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function formatNetworkError(error) {
  const message = String(error?.message || error || "Unknown network error");
  const causeCode = error?.cause?.code ? String(error.cause.code) : "";
  const causeMessage = error?.cause?.message ? String(error.cause.message) : "";
  if (!causeCode && !causeMessage) return message;
  if (causeCode && causeMessage) return `${message} (${causeCode}: ${causeMessage})`;
  if (causeCode) return `${message} (${causeCode})`;
  return `${message} (${causeMessage})`;
}

function trimKnownModelPathSuffix(baseUrl) {
  const clean = trimTrailingSlash(baseUrl);
  return clean
    .replace(/\/api\/generate$/i, "")
    .replace(/\/api\/chat$/i, "")
    .replace(/\/v1\/chat\/completions$/i, "")
    .replace(/\/v1\/completions$/i, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/v1$/i, "");
}

function buildCandidateUrls(baseUrl) {
  const clean = trimTrailingSlash(baseUrl);
  const candidates = [];

  if (clean.endsWith("/v1")) {
    candidates.push(`${clean}/chat/completions`);
    candidates.push(`${clean}/completions`);
  } else if (clean.endsWith("/api/generate")) {
    candidates.push(clean);
  } else if (clean.endsWith("/api/chat")) {
    candidates.push(clean);
  } else {
    candidates.push(`${clean}/api/generate`);
    candidates.push(`${clean}/api/chat`);
    candidates.push(`${clean}/v1/chat/completions`);
    candidates.push(`${clean}/chat/completions`);
    candidates.push(clean);
  }

  return [...new Set(candidates)];
}

function parseJsonObject(text) {
  const value = String(text || "").trim();
  try {
    return JSON.parse(value);
  } catch {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      throw new Error("Model did not return parseable JSON");
    }
    return JSON.parse(value.slice(start, end + 1));
  }
}

function contentToString(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.refusal === "string") return part.refusal;
        return "";
      })
      .join("\n")
      .trim();
  }
  return "";
}

function extractTextOutput(responseJson) {
  const chatContent = responseJson?.choices?.[0]?.message?.content;
  if (chatContent !== undefined) {
    return contentToString(chatContent);
  }

  if (typeof responseJson?.choices?.[0]?.text === "string") {
    return responseJson.choices[0].text;
  }

  if (typeof responseJson?.response === "string") {
    return responseJson.response;
  }

  if (typeof responseJson?.output_text === "string") {
    return responseJson.output_text;
  }

  if (typeof responseJson?.message?.content === "string") {
    return responseJson.message.content;
  }

  return "";
}

function extractPromptFromPayload(payload) {
  if (Array.isArray(payload?.messages) && payload.messages.length > 0) {
    const content = payload.messages[payload.messages.length - 1]?.content;
    if (typeof content === "string") return content;
  }
  return "";
}

function buildRequestForUrl(url, payload) {
  if (url.includes("/api/generate")) {
    return {
      body: {
        model: payload.model,
        prompt: extractPromptFromPayload(payload),
        stream: false,
        options: {
          temperature: payload.temperature ?? 0
        }
      }
    };
  }

  if (url.includes("/api/chat")) {
    return {
      body: {
        model: payload.model,
        messages: payload.messages || [],
        stream: false,
        options: {
          temperature: payload.temperature ?? 0
        }
      }
    };
  }

  return { body: payload };
}

function normalizeModelResponse(responseJson) {
  const text = extractTextOutput(responseJson);
  if (text) return parseJsonObject(text);

  if (typeof responseJson === "object" && responseJson && !Array.isArray(responseJson)) {
    return responseJson;
  }

  throw new Error("Unknown model response format");
}

function buildHeaders(settings) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (settings.modelApiKey) {
    headers.Authorization = `Bearer ${settings.modelApiKey}`;
  } else if (settings.modelBasicAuth) {
    headers.Authorization = `Basic ${Buffer.from(settings.modelBasicAuth).toString("base64")}`;
  }

  return headers;
}

function buildAuthHeaders({ modelApiKey, modelBasicAuth }) {
  const headers = {};
  if (modelApiKey) {
    headers.Authorization = `Bearer ${modelApiKey}`;
  } else if (modelBasicAuth) {
    headers.Authorization = `Basic ${Buffer.from(modelBasicAuth).toString("base64")}`;
  }
  return headers;
}

async function callModelWithFallback({ settings, payload, timeoutMs, normalizer }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let lastError = null;
  const attempts = [];

  try {
    const urls = buildCandidateUrls(settings.modelApiBaseUrl);
    for (const url of urls) {
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: buildHeaders(settings),
          body: JSON.stringify(buildRequestForUrl(url, payload).body),
          signal: controller.signal
        });

        const latencyMs = Date.now() - startedAt;
        const bodyText = await response.text();

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${bodyText}`);
          attempts.push({
            url,
            ok: false,
            latencyMs,
            status: response.status,
            error: String(error.message || error)
          });
          lastError = error;
          continue;
        }

        let parsedJson = null;
        try {
          parsedJson = bodyText ? JSON.parse(bodyText) : null;
        } catch {
          parsedJson = null;
        }

        const data = normalizer(parsedJson || bodyText);
        attempts.push({
          url,
          ok: true,
          latencyMs,
          status: response.status
        });

        return { data, attempts, url, latencyMs, rawResponseText: bodyText, rawResponseJson: parsedJson };
      } catch (error) {
        const normalizedError =
          error?.name === "AbortError"
            ? new Error(`Model timeout after ${timeoutMs}ms`)
            : error;
        const latencyMs = Date.now() - startedAt;
        attempts.push({
          url,
          ok: false,
          latencyMs,
          status: null,
          error: formatNetworkError(normalizedError)
        });
        lastError = normalizedError;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  const finalError = lastError || new Error("Model request failed");
  finalError.attempts = attempts;
  throw finalError;
}

function ensureEnrichmentShape(parsed) {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Model response is not a JSON object");
  }

  const requiredKeys = [
    "owner_firstname",
    "owner_firstname_confidence",
    "closest_competitor",
    "closest_competitor_confidence",
    "top_service",
    "top_service_confidence"
  ];

  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      throw new Error(`Missing required key: ${key}`);
    }
  }

  return parsed;
}

function buildModelPayload({ settings, prompt, options = {} }) {
  const payload = {
    model: settings.modelName,
    temperature: 0,
    stream: false,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  };

  const maxTokens = Number(options.maxTokens || 0);
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens;
  }

  if (settings.modelDisableThinking) {
    payload.think = false;
  }
  if (settings.modelReasoningEffort) {
    payload.reasoning_effort = settings.modelReasoningEffort;
  }

  return payload;
}

export async function inferEnrichment({ settings, prompt, timeoutMs, options = {} }) {
  const payload = buildModelPayload({ settings, prompt, options });

  const response = await callModelWithFallback({
    settings,
    payload,
    timeoutMs,
    normalizer: (raw) => normalizeModelResponse(raw)
  });

  return response.data;
}

export async function inferEnrichmentDetailed({ settings, prompt, timeoutMs, options = {} }) {
  const payload = buildModelPayload({ settings, prompt, options });

  const response = await callModelWithFallback({
    settings,
    payload,
    timeoutMs,
    normalizer: (raw) => normalizeModelResponse(raw)
  });

  return {
    parsed: response.data,
    rawResponseText: response.rawResponseText || "",
    rawResponseJson: response.rawResponseJson || null,
    endpointUrl: response.url,
    attempts: response.attempts,
    payload
  };
}

async function runSingleDiagnosticTest({ settings, name, prompt, validate }) {
  const payload = {
    model: settings.modelName,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: prompt
      }
    ]
  };

  try {
    const response = await callModelWithFallback({
      settings,
      payload,
      timeoutMs: Math.max(
        10000,
        Number(settings.modelRequestTimeoutMs || settings.requestTimeoutMs || 180000)
      ),
      normalizer: (raw) => {
        const parsed = typeof raw === "string" ? parseJsonObject(raw) : normalizeModelResponse(raw);
        return validate(parsed);
      }
    });

    return {
      name,
      ok: true,
      url: response.url,
      latencyMs: response.latencyMs,
      outputPreview: JSON.stringify(response.data).slice(0, 400),
      attempts: response.attempts
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: String(error?.message || error),
      attempts: Array.isArray(error?.attempts) ? error.attempts : []
    };
  }
}

export async function runModelCompatibilityTest({ settings }) {
  const tests = [];

  tests.push(
    await runSingleDiagnosticTest({
      settings,
      name: "basic_json",
      prompt:
        'Return ONLY valid JSON. No markdown. JSON schema: {"ok": true, "model_echo": "string"}.',
      validate: (parsed) => {
        if (!parsed || typeof parsed !== "object") throw new Error("Not a JSON object");
        if (parsed.ok !== true) throw new Error("Expected ok=true");
        if (typeof parsed.model_echo !== "string") {
          throw new Error("Expected model_echo string");
        }
        return parsed;
      }
    })
  );

  tests.push(
    await runSingleDiagnosticTest({
      settings,
      name: "enrichment_schema",
      prompt: `Return ONLY valid JSON. No markdown.
Use this exact schema and include all keys:
{
  "owner_firstname": null,
  "owner_firstname_confidence": 0,
  "closest_competitor": null,
  "closest_competitor_confidence": 0,
  "top_service": null,
  "top_service_confidence": 0
}`,
      validate: (parsed) => ensureEnrichmentShape(parsed)
    })
  );

  tests.push(
    await runSingleDiagnosticTest({
      settings,
      name: "null_discipline",
      prompt: `Return ONLY valid JSON. No markdown.
Business:
Company: Unknown Example Company ZZ
City: Nowhere
State: ZZ
Website: 
Do not guess. Use null when unknown.
Return schema:
{
  "owner_firstname": null,
  "owner_firstname_confidence": 0,
  "closest_competitor": null,
  "closest_competitor_confidence": 0,
  "top_service": null,
  "top_service_confidence": 0
}`,
      validate: (parsed) => {
        const obj = ensureEnrichmentShape(parsed);
        if (obj.owner_firstname !== null) {
          throw new Error("Expected owner_firstname to be null for unknown business");
        }
        return obj;
      }
    })
  );

  return {
    ok: tests.every((item) => item.ok),
    modelName: settings.modelName,
    modelApiBaseUrl: settings.modelApiBaseUrl,
    testedAt: new Date().toISOString(),
    tests
  };
}

export async function fetchOllamaModelTags({
  modelApiBaseUrl,
  modelApiKey = "",
  modelBasicAuth = "",
  timeoutMs = 15000
}) {
  const clean = trimTrailingSlash(modelApiBaseUrl);
  const root = trimKnownModelPathSuffix(clean);
  const candidates = [...new Set([`${root}/api/tags`, `${clean}/api/tags`])];
  const headers = buildAuthHeaders({ modelApiKey, modelBasicAuth });
  const attempts = [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let lastError = null;

  try {
    for (const url of candidates) {
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal
        });
        const latencyMs = Date.now() - startedAt;
        const raw = await response.text();

        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${raw}`);
          attempts.push({
            url,
            ok: false,
            latencyMs,
            status: response.status,
            error: String(error.message || error)
          });
          lastError = error;
          continue;
        }

        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }

        const list = Array.isArray(parsed?.models) ? parsed.models : [];
        const modelNames = list
          .map((item) => (item && typeof item.name === "string" ? item.name.trim() : ""))
          .filter(Boolean);

        attempts.push({
          url,
          ok: true,
          latencyMs,
          status: response.status
        });

        return {
          ok: true,
          endpoint: url,
          models: [...new Set(modelNames)],
          rawResponseJson: parsed,
          attempts
        };
      } catch (error) {
        const normalizedError =
          error?.name === "AbortError"
            ? new Error(`Model tags timeout after ${timeoutMs}ms`)
            : error;
        const latencyMs = Date.now() - startedAt;
        attempts.push({
          url,
          ok: false,
          latencyMs,
          status: null,
          error: formatNetworkError(normalizedError)
        });
        lastError = normalizedError;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return {
    ok: false,
    endpoint: null,
    models: [],
    rawResponseJson: null,
    attempts,
    error: formatNetworkError(lastError || "Failed to load models")
  };
}
