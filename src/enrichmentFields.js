function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function normalizeFieldKey(value, fallback = "field") {
  const raw = normalizeString(value).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

function defaultOwnerPromptTemplate() {
  return `Find owner first name from provided search evidence only.

Input:
Company: \${input.company}
City: \${input.city}
State: \${input.state}
Website: \${input.website}

Rules:
- Return ONLY valid JSON. No markdown.
- Do not guess.
- Use null when unknown.

Evidence:
\${evidenceLines}

Return exactly:
{
  "owner_firstname": null,
  "owner_firstname_confidence": 0
}`;
}

function defaultCompetitorPromptTemplate() {
  return `Find closest local competitor from provided search evidence only.

Input:
Company: \${input.company}
City: \${input.city}
State: \${input.state}
Website: \${input.website}

Rules:
- Return ONLY valid JSON. No markdown.
- Do not guess.
- Use null when unknown.
- Competitor should be same category and same city/state when possible.

Evidence:
\${evidenceLines}

Return exactly:
{
  "closest_competitor": null,
  "closest_competitor_confidence": 0
}`;
}

function defaultTopServicePromptTemplate() {
  return `Find top service from provided search evidence only.

Input:
Company: \${input.company}
City: \${input.city}
State: \${input.state}
Website: \${input.website}

Rules:
- Return ONLY valid JSON. No markdown.
- Do not guess.
- Use null when unknown.
- top_service must be exactly ONE short service label (2-5 words).
- Do not return lists, options, or multiple services.

Evidence:
\${evidenceLines}

Return exactly:
{
  "top_service": null,
  "top_service_confidence": 0
}`;
}

export function getDefaultEnrichmentFields() {
  return [
    {
      key: "owner_firstname",
      label: "Owner First Name",
      enabled: true,
      evidenceSourceField: null,
      queryTemplates:
        "Owner of {{website}} {{city}} {{state}} linkedin\n{{company}} owner {{city}} {{state}} linkedin",
      promptTemplate: defaultOwnerPromptTemplate(),
      confidenceThreshold: 0.6,
      maxTokens: 40
    },
    {
      key: "closest_competitor",
      label: "Closest Competitor",
      enabled: true,
      evidenceSourceField: null,
      queryTemplates:
        "{{company}} competitors {{city}} {{state}}\nbest {{category_or_service}} near {{city}} {{state}}",
      promptTemplate: defaultCompetitorPromptTemplate(),
      confidenceThreshold: 0.75,
      maxTokens: 80
    },
    {
      key: "top_service",
      label: "Top Service",
      enabled: true,
      evidenceSourceField: null,
      queryTemplates:
        "{{company}} {{city}} {{state}} services\n{{company}} {{city}} {{state}} what do they do",
      promptTemplate: defaultTopServicePromptTemplate(),
      confidenceThreshold: 0.75,
      maxTokens: 80
    }
  ];
}

export function normalizeEnrichmentFields(rawFields, fallbackFields = []) {
  const source = Array.isArray(rawFields) && rawFields.length ? rawFields : fallbackFields;
  const out = [];
  const seen = new Set();

  for (let i = 0; i < source.length; i += 1) {
    const row = source[i] || {};
    const key = normalizeFieldKey(row.key, `field_${i + 1}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: normalizeString(row.label) || key,
      enabled: row.enabled !== false,
      evidenceSourceField: (() => {
        const raw = normalizeString(row.evidenceSourceField);
        if (!raw) return null;
        const normalized = normalizeFieldKey(raw, "");
        if (!normalized || normalized === key) return null;
        return normalized;
      })(),
      queryTemplates: normalizeString(row.queryTemplates),
      promptTemplate: normalizeString(row.promptTemplate),
      confidenceThreshold: Number.isFinite(Number(row.confidenceThreshold))
        ? Math.min(1, Math.max(0, Number(row.confidenceThreshold)))
        : null,
      maxTokens: Number.isFinite(Number(row.maxTokens))
        ? Math.max(1, Math.min(1200, Number(row.maxTokens)))
        : null
    });
  }

  return out;
}

export function migrateLegacyFields(settings) {
  const defaults = getDefaultEnrichmentFields();
  if (Array.isArray(settings?.enrichmentFields) && settings.enrichmentFields.length) {
    return normalizeEnrichmentFields(settings.enrichmentFields, defaults);
  }

  return normalizeEnrichmentFields(
    [
      {
        ...defaults[0],
        queryTemplates: settings?.ownerSerpQueryTemplates || defaults[0].queryTemplates
      },
      {
        ...defaults[1],
        queryTemplates: settings?.competitorSerpQueryTemplates || defaults[1].queryTemplates
      },
      {
        ...defaults[2],
        queryTemplates: settings?.serviceSerpQueryTemplates || defaults[2].queryTemplates
      }
    ],
    defaults
  );
}

export function buildNullResultFromFields(fields) {
  const result = {};
  for (const field of fields) {
    result[field.key] = null;
  }
  return result;
}
