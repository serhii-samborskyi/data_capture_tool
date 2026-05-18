const qs = (id) => document.getElementById(id);

const enrichForm = qs("enrichForm");
const settingsForm = qs("settingsForm");
const resultBox = qs("resultBox");
const metaBox = qs("metaBox");
const runQwenParsedBox = qs("runQwenParsedBox");
const runQwenRawBox = qs("runQwenRawBox");
const runDebugBox = qs("runDebugBox");
const runProgressBar = qs("runProgressBar");
const runProgressText = qs("runProgressText");
const compatBox = qs("compatBox");
const fieldDebugForm = qs("fieldDebugForm");
const fieldDebugBox = qs("fieldDebugBox");
const fieldDebugBtn = qs("fieldDebugBtn");
const fieldQwenParsedBox = qs("fieldQwenParsedBox");
const fieldQwenRawBox = qs("fieldQwenRawBox");
const evidenceBody = qs("evidenceBody");
const runsBody = qs("runsBody");
const sampleBtn = qs("sampleBtn");
const modelCompatBtn = qs("modelCompatBtn");
const loadModelsBtn = qs("loadModelsBtn");
const addFieldBtn = qs("addFieldBtn");
const addInputFieldBtn = qs("addInputFieldBtn");
const enrichmentFieldsList = qs("enrichmentFieldsList");
const inputFieldsSettingsList = qs("inputFieldsSettingsList");
const inputFieldsContainer = qs("inputFieldsContainer");
const debugFieldSelect = qs("debugField");
const settingsStatus = qs("settingsStatus");
const modelNameStatus = qs("modelNameStatus");
const refreshApiLogsBtn = qs("refreshApiLogsBtn");
const clearApiLogsBtn = qs("clearApiLogsBtn");
const apiLogsBox = qs("apiLogsBox");
const sysCpu = qs("sysCpu");
const sysRam = qs("sysRam");
const sysGpu = qs("sysGpu");
const sysDisk = qs("sysDisk");
const sysUpdatedAt = qs("sysUpdatedAt");

let activeFieldProbePoll = null;
let activeEnrichPoll = null;
let systemMetricsPoll = null;
let enrichmentFieldsState = [];
let inputFieldsState = [];
let inputValuesState = {};
let modelNameSuggestionsState = [];
const LAST_INPUT_STORAGE_KEY = "data_capture_tool_last_input_v1";

const settingsFields = [
  "modelApiBaseUrl",
  "modelName",
  "modelApiKey",
  "modelBasicAuth",
  "publicApiKey",
  "confidenceThreshold",
  "ownerConfidenceThreshold",
  "requestTimeoutMs",
  "modelRequestTimeoutMs",
  "evidenceRequestTimeoutMs",
  "modelDisableThinking",
  "modelReasoningEffort",
  "ownerMaxTokens",
  "fieldProbeMaxTokens",
  "enrichMaxTokens",
  "cacheTtlHours",
  "useCache",
  "googleSerpOnly",
  "useBrightDataSerp",
  "brightDataSerpMode",
  "brightDataApiToken",
  "brightDataAiModeDatasetId",
  "brightDataAiModeCountry",
  "brightDataAiModeHtmlFallbackChars",
  "brightDataZone",
  "brightDataFormat",
  "brightDataDatasetId",
  "brightDataDatasetInitialWaitMs",
  "brightDataDatasetPollIntervalMs",
  "brightDataDatasetMaxWaitMs",
  "brightDataDatasetFallbackToRequest",
  "profileSerpQueryTemplates",
  "headed",
  "rotateProxyPerSite",
  "proxyRetryCount",
  "browserMaxUses",
  "proxyList"
];

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function normalizeFieldKey(value, fallback = "field") {
  const raw = String(value || "").trim().toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function makeNewInputField() {
  const idx = inputFieldsState.length + 1;
  return {
    key: `input_${idx}`,
    label: `Input ${idx}`,
    required: false,
    placeholder: ""
  };
}

function makeNewField() {
  const idx = enrichmentFieldsState.length + 1;
  return {
    key: `field_${idx}`,
    label: `Field ${idx}`,
    enabled: true,
    queryTemplates: "{{company}} {{city}} {{state}}",
    promptTemplate:
      "Find ${field.label} from provided search evidence only.\\n\\nInput:\\nCompany: ${input.company}\\nCity: ${input.city}\\nState: ${input.state}\\nWebsite: ${input.website}\\n\\nRules:\\n- Return ONLY valid JSON. No markdown.\\n- Do not guess.\\n- Use null when unknown.\\n\\nEvidence:\\n${evidenceLines}\\n\\nReturn exactly:\\n{\\n  \\\"field_name\\\": null,\\n  \\\"field_name_confidence\\\": 0\\n}",
    confidenceThreshold: 0.75,
    maxTokens: 80
  };
}

function syncInputValuesFromDom() {
  const next = {};
  const rows = Array.from(inputFieldsContainer.querySelectorAll("[data-input-key]"));
  for (const row of rows) {
    const key = row.getAttribute("data-input-key");
    const input = row.querySelector("input, textarea");
    if (!key || !input) continue;
    next[key] = input.value;
  }
  inputValuesState = next;
}

function renderInputForm() {
  inputFieldsContainer.innerHTML = inputFieldsState
    .map((field, idx) => {
      const key = normalizeFieldKey(field.key, `input_${idx + 1}`);
      const label = field.label || key;
      const value = inputValuesState[key] ?? "";
      return `
      <label data-input-key="${escapeHtml(key)}">
        ${escapeHtml(label)}
        <input ${field.required ? "required" : ""} placeholder="${escapeHtml(field.placeholder || "")}" value="${escapeHtml(value)}" />
      </label>`;
    })
    .join("");
}

function syncInputFieldsSettingsFromDom() {
  const cards = Array.from(inputFieldsSettingsList.querySelectorAll(".input-field-card"));
  const next = cards.map((card, idx) => {
    const read = (prop) => card.querySelector(`[data-prop=\"${prop}\"]`);
    const key = normalizeFieldKey(read("key")?.value, `input_${idx + 1}`);
    return {
      key,
      label: (read("label")?.value || "").trim() || key,
      required: Boolean(read("required")?.checked),
      placeholder: (read("placeholder")?.value || "").trim()
    };
  });

  const oldValues = { ...inputValuesState };
  const remapped = {};
  for (const field of next) {
    remapped[field.key] = oldValues[field.key] ?? "";
  }

  inputFieldsState = next;
  inputValuesState = remapped;
}

function renderInputFieldsSettings() {
  if (!inputFieldsState.length) {
    inputFieldsSettingsList.innerHTML = `<p class=\"meta\">No input fields yet. Add one.</p>`;
    renderInputForm();
    return;
  }

  inputFieldsSettingsList.innerHTML = inputFieldsState
    .map((field, idx) => {
      return `
      <div class="field-card input-field-card" data-input-field-index="${idx}">
        <div class="field-card-grid">
          <label>
            Input Key
            <input data-prop="key" value="${escapeHtml(field.key)}" placeholder="zip_code" />
          </label>
          <label>
            Label
            <input data-prop="label" value="${escapeHtml(field.label || "")}" placeholder="Zip Code" />
          </label>
          <label>
            Placeholder
            <input data-prop="placeholder" value="${escapeHtml(field.placeholder || "")}" placeholder="60647" />
          </label>
          <label class="checkbox-row">
            <input data-prop="required" type="checkbox" ${field.required ? "checked" : ""} />
            Required
          </label>
        </div>
        <div class="actions">
          <button type="button" class="ghost" data-remove-input-field="${idx}">Remove</button>
        </div>
      </div>`;
    })
    .join("");

  renderInputForm();
}

function renderDebugFieldOptions() {
  const previous = debugFieldSelect.value;
  const enabledFields = enrichmentFieldsState.filter((field) => field.enabled !== false);

  if (!enabledFields.length) {
    debugFieldSelect.innerHTML = `<option value="">No fields defined</option>`;
    return;
  }

  debugFieldSelect.innerHTML = enabledFields
    .map((field) => `<option value="${escapeHtml(field.key)}">${escapeHtml(field.key)}</option>`)
    .join("");

  if (enabledFields.some((field) => field.key === previous)) {
    debugFieldSelect.value = previous;
  }
}

function syncFieldStateFromDom() {
  const cards = Array.from(enrichmentFieldsList.querySelectorAll(".field-card"));
  enrichmentFieldsState = cards.map((card, idx) => {
    const read = (prop) => card.querySelector(`[data-prop=\"${prop}\"]`);
    const key = normalizeFieldKey(read("key")?.value, `field_${idx + 1}`);
    const label = (read("label")?.value || "").trim();
    const confidenceRaw = read("confidenceThreshold")?.value;
    const maxTokensRaw = read("maxTokens")?.value;

    return {
      key,
      label,
      enabled: Boolean(read("enabled")?.checked),
      queryTemplates: read("queryTemplates")?.value || "",
      promptTemplate: read("promptTemplate")?.value || "",
      confidenceThreshold: confidenceRaw === "" ? null : Number(confidenceRaw),
      maxTokens: maxTokensRaw === "" ? null : Number(maxTokensRaw)
    };
  });
}

function renderEnrichmentFields() {
  if (!enrichmentFieldsState.length) {
    enrichmentFieldsList.innerHTML = `<p class="meta">No fields yet. Add one.</p>`;
    renderDebugFieldOptions();
    return;
  }

  enrichmentFieldsList.innerHTML = enrichmentFieldsState
    .map((field, idx) => {
      const statusText = field.enabled !== false ? "enabled" : "disabled";
      return `
      <details class="field-card" data-field-index="${idx}">
        <summary class="field-card-summary">
          <span class="field-card-title">${escapeHtml(field.label || field.key)}</span>
          <span class="field-card-meta">${escapeHtml(field.key)} • ${statusText}</span>
        </summary>
        <div class="field-card-body">
          <div class="field-card-grid">
            <label>
              Field Key
              <input data-prop="key" value="${escapeHtml(field.key)}" placeholder="top_service" />
            </label>
            <label>
              Label
              <input data-prop="label" value="${escapeHtml(field.label || "")}" placeholder="Top Service" />
            </label>
            <label>
              Confidence Threshold (0..1)
              <input data-prop="confidenceThreshold" type="number" step="0.01" min="0" max="1" value="${escapeHtml(
                field.confidenceThreshold ?? ""
              )}" />
            </label>
            <label>
              Max Tokens
              <input data-prop="maxTokens" type="number" min="1" max="1200" value="${escapeHtml(
                field.maxTokens ?? ""
              )}" />
            </label>
            <label class="checkbox-row">
              <input data-prop="enabled" type="checkbox" ${field.enabled !== false ? "checked" : ""} />
              Enabled
            </label>
          </div>
          <label>
            Query Templates (one per line)
            <textarea data-prop="queryTemplates" rows="3">${escapeHtml(field.queryTemplates || "")}</textarea>
          </label>
          <label>
            Prompt Template
            <textarea data-prop="promptTemplate" rows="8">${escapeHtml(field.promptTemplate || "")}</textarea>
          </label>
          <div class="actions">
            <button type="button" class="ghost" data-remove-field="${idx}">Remove</button>
          </div>
        </div>
      </details>`;
    })
    .join("");

  renderDebugFieldOptions();
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || "Request failed");
  return data;
}

function setBusy(button, busy, labelWhenBusy = "Running...") {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.prevLabel = button.textContent;
    button.textContent = labelWhenBusy;
  } else if (button.dataset.prevLabel) {
    button.textContent = button.dataset.prevLabel;
  }
}

function setRunProgress(percent, text = "") {
  const clamped = Math.max(0, Math.min(100, Number(percent || 0)));
  if (runProgressBar) runProgressBar.style.width = `${clamped}%`;
  if (runProgressText && text) runProgressText.textContent = `${Math.round(clamped)}% - ${text}`;
}

function saveLastInputValues(values) {
  try {
    localStorage.setItem(LAST_INPUT_STORAGE_KEY, JSON.stringify(values || {}));
  } catch {
    // ignore storage failures
  }
}

function loadLastInputValues() {
  try {
    const raw = localStorage.getItem(LAST_INPUT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function renderModelNameSuggestions(models = [], currentValue = "") {
  const uniq = [...new Set(models.map((item) => String(item || "").trim()).filter(Boolean))];
  modelNameSuggestionsState = uniq;
  const modelSelect = qs("modelName");
  const previousSelected = String(modelSelect?.value || "").trim();
  const current = String(currentValue || "").trim();
  const withCurrent = current && !uniq.includes(current) ? [...uniq, current] : uniq;

  modelSelect.innerHTML = [
    `<option value="">Select model from API...</option>`,
    ...withCurrent.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
  ].join("");

  if (withCurrent.includes(previousSelected)) {
    modelSelect.value = previousSelected;
  } else if (withCurrent.includes(current)) {
    modelSelect.value = current;
  }
}

async function loadModelNamesFromApi() {
  const modelApiBaseUrl = String(qs("modelApiBaseUrl")?.value || "").trim();
  const modelApiKey = String(qs("modelApiKey")?.value || "").trim();
  const modelBasicAuth = String(qs("modelBasicAuth")?.value || "").trim();

  if (!modelApiBaseUrl) {
    modelNameStatus.textContent = "Set Model API Base URL first.";
    return;
  }

  setBusy(loadModelsBtn, true, "Loading...");
  modelNameStatus.textContent = "Loading models from Ollama...";

  try {
    const report = await fetchJson("/api/debug/model-tags", {
      method: "POST",
      body: JSON.stringify({
        modelApiBaseUrl,
        modelApiKey,
        modelBasicAuth
      })
    });

    if (!report.ok) {
      modelNameStatus.textContent = `Load failed: ${String(report.error || "Unknown error")}`;
      return;
    }

    const rawModels = Array.isArray(report?.rawResponseJson?.models) ? report.rawResponseJson.models : [];
    const modelsFromRaw = rawModels
      .map((item) => (item && typeof item.name === "string" ? item.name.trim() : ""))
      .filter(Boolean);
    const modelsFromTop = Array.isArray(report.models) ? report.models : [];
    const models = [...new Set([...modelsFromRaw, ...modelsFromTop])];
    const current = String(qs("modelName")?.value || "").trim();
    renderModelNameSuggestions(models, current);

    if (!current && models.length) {
      qs("modelName").value = models[0];
    }

    modelNameStatus.textContent = `Loaded ${models.length} model(s) from ${report.endpoint}`;
  } catch (error) {
    modelNameStatus.textContent = `Load failed: ${String(error.message || error)}`;
  } finally {
    setBusy(loadModelsBtn, false);
  }
}

function populateSettings(settings) {
  for (const field of settingsFields) {
    const el = qs(field);
    if (!el) continue;
    if (el.type === "checkbox") {
      el.checked = Boolean(settings[field]);
    } else {
      el.value = settings[field] ?? "";
    }
  }
  renderModelNameSuggestions(modelNameSuggestionsState, settings.modelName);
  modelNameStatus.textContent = "";

  inputFieldsState = Array.isArray(settings.inputFields) ? settings.inputFields.map((x) => ({ ...x })) : [];
  enrichmentFieldsState = Array.isArray(settings.enrichmentFields)
    ? settings.enrichmentFields.map((x) => ({ ...x }))
    : [];

  const savedValues = loadLastInputValues();
  const nextValues = {};
  for (const field of inputFieldsState) {
    nextValues[field.key] =
      inputValuesState[field.key] ?? savedValues[field.key] ?? "";
  }
  inputValuesState = nextValues;

  renderInputFieldsSettings();
  renderEnrichmentFields();
}

function readSettingsForm() {
  const data = {};
  for (const field of settingsFields) {
    const el = qs(field);
    if (!el) continue;

    if (el.type === "checkbox") {
      data[field] = el.checked;
    } else if (el.type === "number") {
      const raw = String(el.value || "").trim();
      if (!raw) continue;
      const num = Number(raw);
      if (Number.isFinite(num)) data[field] = num;
    } else {
      data[field] = el.value;
    }
  }

  syncInputFieldsSettingsFromDom();
  syncFieldStateFromDom();

  data.inputFields = inputFieldsState;
  data.enrichmentFields = enrichmentFieldsState;

  return data;
}

function readInputPayload() {
  syncInputValuesFromDom();
  const input = { ...inputValuesState };

  return {
    input,
    company: input.company || "",
    city: input.city || "",
    state: input.state || "",
    website: input.website || null
  };
}

function getMissingRequiredInputFields(payload) {
  const input = payload?.input || {};
  return inputFieldsState
    .filter((field) => field.required)
    .filter((field) => !String(input[field.key] || "").trim())
    .map((field) => field.label || field.key);
}

function getSelectedModelName() {
  return String(qs("modelName")?.value || "").trim();
}

function renderEvidence(evidences = []) {
  if (!evidences.length) {
    evidenceBody.innerHTML = `<tr><td colspan="3">No evidence.</td></tr>`;
    return;
  }

  evidenceBody.innerHTML = evidences
    .map((e) => {
      const safeUrl = e.url || "";
      const shownSnippet = String(e.snippet || "").slice(0, 400);
      return `
        <tr>
          <td>${e.sourceType || "-"}</td>
          <td><a href="${safeUrl}" target="_blank" rel="noreferrer">${safeUrl}</a></td>
          <td>${shownSnippet.replace(/</g, "&lt;")}</td>
        </tr>
      `;
    })
    .join("");
}

function renderRuns(runs = []) {
  if (!runs.length) {
    runsBody.innerHTML = `<tr><td colspan="5">No runs yet.</td></tr>`;
    return;
  }

  runsBody.innerHTML = runs
    .map((run) => {
      const business = `${run.company}, ${run.city}, ${run.state}`;
      return `
        <tr>
          <td>${run.id}</td>
          <td>${business}</td>
          <td>${run.status}</td>
          <td><code>${JSON.stringify(run.result)}</code></td>
          <td>${new Date(run.createdAt).toLocaleString()}</td>
        </tr>
      `;
    })
    .join("");
}

async function loadSettings() {
  const settings = await fetchJson("/api/settings");
  populateSettings(settings);
}

async function loadRuns() {
  const runs = await fetchJson("/api/runs?limit=20");
  renderRuns(runs);
}

async function loadApiLogs() {
  const data = await fetchJson("/api/logs/enrichment?limit=100");
  const logs = Array.isArray(data?.logs) ? data.logs : [];
  apiLogsBox.textContent = JSON.stringify(logs, null, 2);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(1)}%`;
}

function formatGb(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  return `${Number(value).toFixed(1)}GB`;
}

function renderSystemMetrics(data) {
  const cpu = data?.cpu || {};
  const ram = data?.ram || {};
  const disk = data?.disk || null;
  const gpu = data?.gpu || null;

  sysCpu.textContent = `${formatPercent(cpu.loadPercent)}${cpu.cores ? ` (${cpu.cores}c)` : ""}`;
  sysRam.textContent = `${formatPercent(ram.usedPercent)} (${formatGb(ram.usedGb)} / ${formatGb(ram.totalGb)})`;
  sysDisk.textContent = disk
    ? `${formatPercent(disk.usedPercent)} (${formatGb(disk.usedGb)} / ${formatGb(disk.totalGb)})`
    : "--";

  if (gpu && gpu.utilizationPercent !== null) {
    const memPart =
      gpu.memoryUsedMb !== null && gpu.memoryTotalMb !== null
        ? ` | VRAM ${gpu.memoryUsedMb}/${gpu.memoryTotalMb}MB`
        : "";
    sysGpu.textContent = `${formatPercent(gpu.utilizationPercent)}${memPart}`;
  } else {
    sysGpu.textContent = "N/A";
  }

  const ts = data?.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : "--";
  sysUpdatedAt.textContent = `System metrics updated: ${ts}`;
}

async function loadSystemMetrics() {
  try {
    const data = await fetchJson("/api/system/metrics");
    renderSystemMetrics(data);
  } catch {
    sysCpu.textContent = "--";
    sysRam.textContent = "--";
    sysGpu.textContent = "--";
    sysDisk.textContent = "--";
    sysUpdatedAt.textContent = "System metrics unavailable";
  }
}

async function startSystemMetricsPolling() {
  if (systemMetricsPoll) {
    clearInterval(systemMetricsPoll);
    systemMetricsPoll = null;
  }
  await loadSystemMetrics();
  systemMetricsPoll = setInterval(() => {
    loadSystemMetrics();
  }, 4000);
}

function dynamicNullResult() {
  syncFieldStateFromDom();
  const out = {};
  for (const field of enrichmentFieldsState) {
    if (!field.key) continue;
    out[field.key] = null;
  }
  return out;
}

async function runEnrichDebug(payload) {
  const runBtn = qs("runBtn");
  setBusy(runBtn, true);
  setRunProgress(0, "Starting...");
  if (activeEnrichPoll) {
    clearInterval(activeEnrichPoll);
    activeEnrichPoll = null;
  }

  try {
    const started = await fetchJson("/api/enrich-debug/start", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const jobId = started.jobId;
    runDebugBox.textContent = `Job started: ${jobId}\nWaiting for updates...`;

    await new Promise((resolve, reject) => {
      activeEnrichPoll = setInterval(async () => {
        try {
          const job = await fetchJson(`/api/enrich-debug/job/${encodeURIComponent(jobId)}`);
          const logsText = Array.isArray(job.logs) ? job.logs.join("\n") : "";
          runDebugBox.textContent = `Job: ${job.id}\nStatus: ${job.status}\n\n${logsText}`;
          setRunProgress(Number(job.progress || 0), job.status);

          if (job.status === "completed") {
            clearInterval(activeEnrichPoll);
            activeEnrichPoll = null;
            const data = job.result || {};
            resultBox.textContent = JSON.stringify(data.result, null, 2);
            metaBox.textContent = `runId=${data.meta?.runId} | cached=${data.meta?.cached} | overall=${data.meta?.confidences?.overallConfidence}`;
            runQwenParsedBox.textContent = JSON.stringify(
              data.debug?.modelParsedBeforeThreshold || null,
              null,
              2
            );
            runQwenRawBox.textContent = String(data.debug?.modelRawResponseText || "");
            runDebugBox.textContent = `${runDebugBox.textContent}\n\n=== RESULT ===\n${JSON.stringify(
              data.debug || data,
              null,
              2
            )}`;
            renderEvidence(data.evidences || []);
            setRunProgress(100, "Completed");
            resolve();
            return;
          }

          if (job.status === "failed") {
            clearInterval(activeEnrichPoll);
            activeEnrichPoll = null;
            setRunProgress(100, "Failed");
            reject(new Error(job.error || "Enrichment failed"));
          }
        } catch (pollError) {
          clearInterval(activeEnrichPoll);
          activeEnrichPoll = null;
          reject(pollError);
        }
      }, 1000);
    });
    await loadRuns();
  } catch (error) {
    resultBox.textContent = JSON.stringify(
      {
        ...dynamicNullResult(),
        error: String(error.message || error)
      },
      null,
      2
    );
    metaBox.textContent = "run failed";
    runQwenParsedBox.textContent = "null";
    runQwenRawBox.textContent = "";
    runDebugBox.textContent = JSON.stringify({ error: String(error.message || error) }, null, 2);
    renderEvidence([]);
    setRunProgress(0, "Idle");
  } finally {
    setBusy(runBtn, false);
  }
}

enrichForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = readInputPayload();
  saveLastInputValues(payload.input || {});
  const missing = getMissingRequiredInputFields(payload);
  if (missing.length) {
    resultBox.textContent = JSON.stringify(
      {
        ok: false,
        error: `Missing required input fields: ${missing.join(", ")}`
      },
      null,
      2
    );
    return;
  }

  if (!getSelectedModelName()) {
    resultBox.textContent = JSON.stringify(
      {
        ok: false,
        error: "Model Name is not selected in Settings."
      },
      null,
      2
    );
    return;
  }

  await runEnrichDebug(payload);
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsStatus.textContent = "Saving settings...";
  try {
    const payload = readSettingsForm();
    await fetchJson("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    await loadSettings();
    settingsStatus.textContent = "Settings saved.";
  } catch (error) {
    settingsStatus.textContent = `Save failed: ${String(error.message || error)}`;
  }
});

addInputFieldBtn?.addEventListener("click", () => {
  syncInputFieldsSettingsFromDom();
  inputFieldsState.push(makeNewInputField());
  renderInputFieldsSettings();
});

inputFieldsSettingsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-input-field]");
  if (!button) return;

  syncInputFieldsSettingsFromDom();
  const idx = Number(button.getAttribute("data-remove-input-field"));
  inputFieldsState = inputFieldsState.filter((_item, i) => i !== idx);
  const nextValues = {};
  for (const field of inputFieldsState) nextValues[field.key] = inputValuesState[field.key] ?? "";
  inputValuesState = nextValues;
  renderInputFieldsSettings();
});

inputFieldsSettingsList?.addEventListener("input", () => {
  syncInputFieldsSettingsFromDom();
  renderInputForm();
});

inputFieldsContainer?.addEventListener("input", () => {
  syncInputValuesFromDom();
});

addFieldBtn?.addEventListener("click", () => {
  syncFieldStateFromDom();
  enrichmentFieldsState.push(makeNewField());
  renderEnrichmentFields();
});

enrichmentFieldsList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-field]");
  if (!button) return;

  syncFieldStateFromDom();
  const idx = Number(button.getAttribute("data-remove-field"));
  enrichmentFieldsState = enrichmentFieldsState.filter((_item, i) => i !== idx);
  renderEnrichmentFields();
});

enrichmentFieldsList?.addEventListener("input", () => {
  syncFieldStateFromDom();
  renderDebugFieldOptions();
});

enrichmentFieldsList?.addEventListener("change", () => {
  syncFieldStateFromDom();
  renderDebugFieldOptions();
});

sampleBtn.addEventListener("click", async () => {
  setBusy(sampleBtn, true, "Running sample...");
  try {
    const data = await fetchJson("/api/debug/run-sample", { method: "POST" });
    resultBox.textContent = JSON.stringify(data.result, null, 2);
    metaBox.textContent = `runId=${data.meta.runId} | cached=${data.meta.cached} | overall=${data.meta.confidences.overallConfidence}`;
    renderEvidence(data.evidences || []);
    await loadRuns();
  } catch (error) {
    resultBox.textContent = String(error.message || error);
  } finally {
    setBusy(sampleBtn, false);
  }
});

modelCompatBtn.addEventListener("click", async () => {
  setBusy(modelCompatBtn, true, "Testing model...");
  compatBox.textContent = "Running compatibility tests...";
  try {
    const report = await fetchJson("/api/debug/model-compatibility-test", { method: "POST" });
    compatBox.textContent = JSON.stringify(report, null, 2);
  } catch (error) {
    compatBox.textContent = JSON.stringify(
      {
        ok: false,
        error: String(error.message || error)
      },
      null,
      2
    );
  } finally {
    setBusy(modelCompatBtn, false);
  }
});

refreshApiLogsBtn?.addEventListener("click", async () => {
  setBusy(refreshApiLogsBtn, true, "Loading...");
  try {
    await loadApiLogs();
  } catch (error) {
    apiLogsBox.textContent = JSON.stringify(
      { ok: false, error: String(error?.message || error) },
      null,
      2
    );
  } finally {
    setBusy(refreshApiLogsBtn, false);
  }
});

clearApiLogsBtn?.addEventListener("click", async () => {
  const confirmed = window.confirm("Clear all API logs?");
  if (!confirmed) return;
  setBusy(clearApiLogsBtn, true, "Clearing...");
  try {
    await fetchJson("/api/logs/enrichment/clear", { method: "POST" });
    await loadApiLogs();
  } catch (error) {
    apiLogsBox.textContent = JSON.stringify(
      { ok: false, error: String(error?.message || error) },
      null,
      2
    );
  } finally {
    setBusy(clearApiLogsBtn, false);
  }
});

loadModelsBtn?.addEventListener("click", async () => {
  await loadModelNamesFromApi();
});

fieldDebugForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setBusy(fieldDebugBtn, true, "Running field probe...");
  fieldDebugBox.textContent = "Running...";
  if (activeFieldProbePoll) {
    clearInterval(activeFieldProbePoll);
    activeFieldProbePoll = null;
  }

  try {
    const payload = {
      ...readInputPayload(),
      field: qs("debugField").value,
      queryTemplate: qs("debugQueryTemplate").value.trim() || null
    };
    const missing = getMissingRequiredInputFields(payload);
    if (missing.length) {
      throw new Error(`Missing required input fields: ${missing.join(", ")}`);
    }

    if (!getSelectedModelName()) {
      throw new Error("Model Name is not selected in Settings.");
    }

    const started = await fetchJson("/api/debug/field-probe/start", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    const jobId = started.jobId;
    fieldDebugBox.textContent = `Job started: ${jobId}\nWaiting for updates...`;

    await new Promise((resolve, reject) => {
      activeFieldProbePoll = setInterval(async () => {
        try {
          const job = await fetchJson(`/api/debug/field-probe/job/${encodeURIComponent(jobId)}`);
          const logsText = Array.isArray(job.logs) ? job.logs.join("\n") : "";
          fieldDebugBox.textContent = `Job: ${job.id}\nStatus: ${job.status}\n\n${logsText}`;

          if (job.status === "completed") {
            clearInterval(activeFieldProbePoll);
            activeFieldProbePoll = null;
            const data = job.result || {};
            fieldQwenParsedBox.textContent = JSON.stringify(data.model?.parsed || null, null, 2);
            fieldQwenRawBox.textContent = String(data.model?.rawResponseText || "");
            fieldDebugBox.textContent = `${fieldDebugBox.textContent}\n\n=== RESULT ===\n${JSON.stringify(
              data,
              null,
              2
            )}`;
            resolve();
            return;
          }

          if (job.status === "failed") {
            clearInterval(activeFieldProbePoll);
            activeFieldProbePoll = null;
            fieldQwenParsedBox.textContent = "null";
            fieldQwenRawBox.textContent = "";
            reject(new Error(job.error || "Field probe failed"));
          }
        } catch (pollError) {
          clearInterval(activeFieldProbePoll);
          activeFieldProbePoll = null;
          reject(pollError);
        }
      }, 1000);
    });
  } catch (error) {
    fieldQwenParsedBox.textContent = "null";
    fieldQwenRawBox.textContent = "";
    fieldDebugBox.textContent = JSON.stringify(
      {
        ok: false,
        error: String(error.message || error)
      },
      null,
      2
    );
  } finally {
    setBusy(fieldDebugBtn, false);
  }
});

(async function init() {
  await loadSettings();
  await loadRuns();
  await loadApiLogs();
  await startSystemMetricsPolling();
})();

window.addEventListener("beforeunload", () => {
  if (systemMetricsPoll) {
    clearInterval(systemMetricsPoll);
    systemMetricsPoll = null;
  }
});
