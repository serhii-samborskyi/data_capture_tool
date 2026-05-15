function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

export function normalizeInputFieldKey(value, fallback = "field") {
  const raw = normalizeString(value).toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || fallback;
}

export function getDefaultInputFields() {
  return [
    { key: "company", label: "Company", required: true, placeholder: "e.g. Austin Rooter Co" },
    { key: "city", label: "City", required: true, placeholder: "Austin" },
    { key: "state", label: "State", required: true, placeholder: "TX" },
    { key: "website", label: "Website", required: false, placeholder: "https://example.com" }
  ];
}

export function normalizeInputFields(rawFields, fallbackFields = []) {
  const source = Array.isArray(rawFields) && rawFields.length ? rawFields : fallbackFields;
  const out = [];
  const seen = new Set();

  for (let i = 0; i < source.length; i += 1) {
    const row = source[i] || {};
    const key = normalizeInputFieldKey(row.key, `field_${i + 1}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      label: normalizeString(row.label) || key,
      required: row.required !== false,
      placeholder: normalizeString(row.placeholder)
    });
  }

  return out;
}

export function migrateInputFields(settings) {
  const defaults = getDefaultInputFields();
  if (Array.isArray(settings?.inputFields) && settings.inputFields.length) {
    return normalizeInputFields(settings.inputFields, defaults);
  }
  return defaults;
}

