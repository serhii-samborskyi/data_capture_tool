import { browserManager } from "./browserManager.js";
import { parseProxyList, pickProxy } from "./proxy.js";
import { migrateLegacyFields, normalizeFieldKey } from "./enrichmentFields.js";

function normalizeWebsite(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `https://${raw}`;
}

function truncate(text, maxLen = 3200) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function parseTemplateLines(text, fallback = "") {
  const raw = String(text || fallback || "");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderTemplate(template, vars) {
  return String(template || "").replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_m, key) => {
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });
}

function stringifyVar(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function buildTemplateVars(input, extraVars = {}) {
  const website = normalizeWebsite(input.website) || "";
  const base = Object.fromEntries(
    Object.entries(input || {}).map(([key, value]) => [key, stringifyVar(value)])
  );
  const extra = Object.fromEntries(
    Object.entries(extraVars || {}).map(([key, value]) => [key, stringifyVar(value)])
  );
  return {
    ...base,
    ...extra,
    company: base.company || "",
    city: base.city || "",
    state: base.state || "",
    website,
    category_or_service: base.category_or_service || "local service"
  };
}

function buildPlanFromTemplates({ templates, vars, type, field }) {
  return templates.map((template) => ({
    type,
    field,
    mode: "search",
    engine: "google",
    serpOnly: true,
    queryTemplate: template,
    query: renderTemplate(template, vars)
  }));
}

export function buildPlansFromTemplateText({ input, templateText, field, type, extraVars = {} }) {
  const vars = buildTemplateVars(input, extraVars);
  const templates = parseTemplateLines(templateText, "{{company}} {{city}} {{state}}");
  return buildPlanFromTemplates({
    templates,
    vars,
    type,
    field
  });
}

function buildGoogleSerpOnlyPlan(input, settings) {
  const vars = buildTemplateVars(input);

  const profileTemplates = parseTemplateLines(
    settings.profileSerpQueryTemplates,
    "{{company}} {{city}} {{state}}"
  );
  const dynamicFieldPlans = migrateLegacyFields(settings)
    .filter((field) => field.enabled)
    .flatMap((field) => {
      const templates = parseTemplateLines(field.queryTemplates, "{{company}} {{city}} {{state}}");
      return buildPlanFromTemplates({
        templates,
        vars,
        type: `google_serp_${normalizeFieldKey(field.key, "field")}`,
        field: field.key
      });
    });

  return [
    ...buildPlanFromTemplates({
      templates: profileTemplates,
      vars,
      type: "google_serp_profile",
      field: "business_profile"
    }),
    ...dynamicFieldPlans
  ];
}

function buildSourcePlan(input, settings) {
  if (settings.googleSerpOnly) {
    return buildGoogleSerpOnlyPlan(input, settings);
  }

  const allowedSources = settings.allowedSources || [];
  const company = `${input.company} ${input.city} ${input.state}`.trim();
  const website = normalizeWebsite(input.website);

  const plans = [];

  if (allowedSources.includes("company_site") && website) {
    plans.push({ type: "company_site", mode: "direct", url: website, field: "business_profile" });
  }

  if (allowedSources.includes("google_maps")) {
    plans.push({
      type: "google_maps",
      mode: "direct",
      field: "business_profile",
      url: `https://www.google.com/maps/search/${encodeURIComponent(company)}`
    });
  }

  if (allowedSources.includes("yelp")) {
    plans.push({
      type: "yelp",
      mode: "search",
      engine: "duckduckgo",
      field: "business_profile",
      query: `${input.company} ${input.city} ${input.state} site:yelp.com`
    });
  }

  if (allowedSources.includes("linkedin")) {
    plans.push({
      type: "linkedin",
      mode: "search",
      engine: "duckduckgo",
      field: "owner_firstname",
      query: `${input.company} ${input.city} ${input.state} site:linkedin.com/company`
    });
  }

  if (allowedSources.includes("bbb")) {
    plans.push({
      type: "bbb",
      mode: "search",
      engine: "duckduckgo",
      field: "business_profile",
      query: `${input.company} ${input.city} ${input.state} site:bbb.org`
    });
  }

  return plans;
}

function hostIncludes(url, targetPart) {
  try {
    return new URL(url).hostname.toLowerCase().includes(targetPart);
  } catch {
    return false;
  }
}

function decodeGoogleHref(href) {
  try {
    if (!href) return "";
    if (href.startsWith("http://") || href.startsWith("https://")) return href;
    if (href.startsWith("/url?")) {
      const url = new URL(`https://www.google.com${href}`);
      const target = url.searchParams.get("q") || "";
      return target;
    }
    return "";
  } catch {
    return "";
  }
}

function buildSearchUrl(query, engine = "duckduckgo") {
  if (engine === "google") {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
  }
  return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripHtmlToText(html) {
  const withoutScripts = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, " ");
  return truncate(decodeHtmlEntities(withoutTags), 9000);
}

function extractTopLinksFromHtml(html) {
  const source = String(html || "");
  const results = [];
  const regex = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let match = null;
  while ((match = regex.exec(source)) !== null && results.length < 10) {
    const href = decodeGoogleHref(match[1]);
    if (!href || !href.startsWith("http")) continue;
    const anchorText = truncate(decodeHtmlEntities(match[2].replace(/<[^>]+>/g, " ")), 140);
    if (!anchorText) continue;
    results.push({ href, text: anchorText });
  }

  return results;
}

function extractTopLinksFromMarkdownText(text) {
  const source = String(text || "");
  const results = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match = null;

  while ((match = regex.exec(source)) !== null && results.length < 10) {
    results.push({
      text: truncate(decodeHtmlEntities(match[1]), 140),
      href: match[2]
    });
  }

  return results;
}

function extractParsedLightOrganicItems(parsed) {
  if (!parsed || typeof parsed !== "object") return [];
  if (Array.isArray(parsed.organic)) return parsed.organic;
  if (Array.isArray(parsed.results)) return parsed.results;
  if (parsed.data && Array.isArray(parsed.data.organic)) return parsed.data.organic;
  return [];
}

function buildCompactOrganicLines(organicItems, limit = 10) {
  return organicItems.slice(0, limit).map((item, idx) => {
    const title = truncate(item.title || item.text || "", 180);
    const link = item.link || item.url || "";
    const desc = truncate(item.description || item.snippet || "", 260);
    return `${idx + 1}. ${title}\nurl: ${link}\ndesc: ${desc}`;
  });
}

async function fetchBrightDataSerpResult(searchUrl, settings, timeoutMs) {
  if (!settings.brightDataApiToken) {
    throw new Error("Bright Data API token is missing");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.brightdata.com/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.brightDataApiToken}`
      },
      body: JSON.stringify({
        zone: settings.brightDataZone || "serp_api1",
        url: searchUrl,
        format: settings.brightDataFormat || "raw",
        data_format: "parsed_light"
      }),
      signal: controller.signal
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Bright Data HTTP ${response.status}: ${truncate(raw, 240)}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    let parsed = null;
    if (contentType.includes("application/json")) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      if (typeof parsed === "string") {
        return { rawText: parsed, parsedJson: null };
      }
      if (parsed && typeof parsed === "object") {
        return {
          rawText:
            typeof parsed.body === "string"
              ? parsed.body
              : typeof parsed.result === "string"
              ? parsed.result
              : typeof parsed.html === "string"
              ? parsed.html
              : typeof parsed.raw === "string"
              ? parsed.raw
              : raw,
          parsedJson: parsed
        };
      }
    }

    return { rawText: raw, parsedJson: parsed };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Bright Data timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function collectFromBrightDataSerp(plan, settings, timeoutMs) {
  const searchUrl = buildSearchUrl(plan.query, "google");
  const bd = await fetchBrightDataSerpResult(searchUrl, settings, timeoutMs);
  const html = bd.rawText;
  const parsedLight = extractParsedLightOrganicItems(bd.parsedJson);
  const compactOrganicLines = buildCompactOrganicLines(parsedLight, 10);
  const compactOrganicText = compactOrganicLines.join("\n\n");
  const serpText = stripHtmlToText(html);
  const linksFromHtml = extractTopLinksFromHtml(html);
  const links =
    linksFromHtml.length > 0 ? linksFromHtml : extractTopLinksFromMarkdownText(String(html || ""));

  const topLinksText = links.slice(0, 10).map((item, idx) => `${idx + 1}. ${item.text} | ${item.href}`).join("\n");
  const snippet = compactOrganicText
    ? `Search query: ${plan.query}\nSearch URL: ${searchUrl}\nTop organic results (compact):\n${compactOrganicText}`
    : `Search query: ${plan.query}\nSearch URL: ${searchUrl}\nTop links:\n${topLinksText}\n\nSERP text:\n${truncate(
        serpText,
        2600
      )}`;

  return {
    sourceType: plan.type,
    field: plan.field || null,
    query: plan.query,
    queryTemplate: plan.queryTemplate || null,
    url: searchUrl,
    snippet: truncate(snippet, 4200),
    debug: {
      provider: "brightdata",
      parsedLightOrganicCount: parsedLight.length,
      compactOrganicPreview: truncate(compactOrganicText, 4000),
      rawResponsePreview: truncate(html, 12000),
      topLinks: links.slice(0, 10)
    }
  };
}

async function collectFromDirectUrl(page, url, sourceType, timeoutMs, field) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForTimeout(1200);

  const title = await page.title().catch(() => "");
  const text = await page
    .evaluate(() => {
      const bodyText = document.body ? document.body.innerText : "";
      return String(bodyText || "");
    })
    .catch(() => "");

  return {
    sourceType,
    field: field || null,
    url: page.url(),
    snippet: truncate(`${title}\n${text}`)
  };
}

async function collectFromSearch(page, plan, timeoutMs) {
  const searchUrl = buildSearchUrl(plan.query, plan.engine || "duckduckgo");
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await page.waitForTimeout(1700);

  const searchPageText = await page
    .evaluate(() => (document.body ? document.body.innerText : ""))
    .catch(() => "");

  const rawLinks = await page
    .$$eval("a[href]", (anchors) =>
      anchors
        .map((a) => ({ href: a.getAttribute("href") || "", text: (a.textContent || "").trim() }))
        .filter((x) => x.href)
    )
    .catch(() => []);

  const links = rawLinks
    .map((item) => {
      const href = (plan.engine || "duckduckgo") === "google" ? decodeGoogleHref(item.href) : item.href;
      return { href, text: item.text };
    })
    .filter((x) => x.href && x.href.startsWith("http"));

  const topLinksText = links
    .slice(0, 10)
    .map((item, idx) => `${idx + 1}. ${item.text} | ${item.href}`)
    .join("\n");

  let combined = `Search query: ${plan.query}\nSearch URL: ${searchUrl}\nTop links:\n${topLinksText}\n\nSERP text:\n${truncate(
    searchPageText,
    5000
  )}`;

  if (!plan.serpOnly) {
    let targetDomain = "";
    if (plan.type === "yelp") targetDomain = "yelp.com";
    if (plan.type === "linkedin") targetDomain = "linkedin.com";
    if (plan.type === "bbb") targetDomain = "bbb.org";

    const candidateLinks = targetDomain
      ? links.filter((item) => hostIncludes(item.href, targetDomain))
      : links;

    for (const candidate of candidateLinks.slice(0, 2)) {
      try {
        await page.goto(candidate.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForTimeout(900);
        const title = await page.title().catch(() => "");
        const pageText = await page
          .evaluate(() => (document.body ? document.body.innerText : ""))
          .catch(() => "");

        combined += `\n\nCandidate URL: ${candidate.href}\nCandidate Title: ${title}\n${truncate(
          pageText,
          1200
        )}`;
      } catch {
        // keep SERP evidence even if candidate pages fail
      }
    }
  }

  return {
    sourceType: plan.type,
    field: plan.field || null,
    query: plan.query,
    queryTemplate: plan.queryTemplate || null,
    url: searchUrl,
    snippet: truncate(combined),
    debug: {
      provider: "playwright",
      rawResponsePreview: truncate(searchPageText, 14000),
      topLinks: links.slice(0, 10)
    }
  };
}

function chooseProxyForAttempt({ proxies, proxyCursorRef, fixedRunProxy, rotateProxyPerSite }) {
  if (!proxies.length) return null;
  if (!rotateProxyPerSite) return fixedRunProxy;

  const picked = pickProxy(proxies, proxyCursorRef.value);
  proxyCursorRef.value = picked.nextCursor;
  return picked.proxy;
}

async function runPlanWithRetries({
  plan,
  settings,
  proxies,
  proxyCursorRef,
  fixedRunProxy,
  timeoutMs,
  onProgress
}) {
  const maxAttempts = Math.max(1, Number(settings.proxyRetryCount || 2) + 1);

  const shouldUseBrightDataSerp =
    plan.mode === "search" &&
    plan.engine === "google" &&
    Boolean(settings.useBrightDataSerp) &&
    Boolean(settings.brightDataApiToken);

  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (onProgress) {
      onProgress(
        `Fetching evidence: field=${plan.field || "unknown"} type=${plan.type} attempt=${attempt}/${maxAttempts}`
      );
    }
    if (shouldUseBrightDataSerp) {
      try {
        return await collectFromBrightDataSerp(plan, settings, timeoutMs);
      } catch (error) {
        lastError = error;
        if (onProgress) onProgress(`Attempt failed (${plan.type}): ${String(error?.message || error)}`);
        continue;
      }
    }

    const proxy = chooseProxyForAttempt({
      proxies,
      proxyCursorRef,
      fixedRunProxy,
      rotateProxyPerSite: Boolean(settings.rotateProxyPerSite)
    });

    const context = await browserManager.newContext({
      headed: Boolean(settings.headed),
      maxUses: Number(settings.browserMaxUses || 10),
      proxy
    });

    const page = await context.newPage();

    try {
      const evidence =
        plan.mode === "direct"
          ? await collectFromDirectUrl(page, plan.url, plan.type, timeoutMs, plan.field)
          : await collectFromSearch(page, plan, timeoutMs);

      await context.close().catch(() => {});
      return evidence;
    } catch (error) {
      lastError = error;
      if (onProgress) onProgress(`Attempt failed (${plan.type}): ${String(error?.message || error)}`);
      await context.close().catch(() => {});
    }
  }

  return {
    sourceType: plan.type,
    field: plan.field || null,
    query: plan.query || null,
    queryTemplate: plan.queryTemplate || null,
    url: plan.mode === "direct" ? plan.url : `search:${plan.query}`,
    snippet: `Source failed: ${lastError ? String(lastError.message || lastError) : "unknown error"}`,
    debug: {
      provider: shouldUseBrightDataSerp ? "brightdata" : "playwright",
      rawResponsePreview: "",
      topLinks: []
    }
  };
}

export async function collectEvidence(input, settings, options = {}) {
  const plans = Array.isArray(options.planOverride)
    ? options.planOverride
    : buildSourcePlan(input, settings);

  const timeoutMs = Math.max(
    5000,
    Number(settings.evidenceRequestTimeoutMs || Math.max(5000, Number(settings.requestTimeoutMs || 60000) / 3))
  );
  const proxies = parseProxyList(settings.proxyList);

  let fixedRunProxy = null;
  const proxyCursorRef = { value: 0 };

  if (proxies.length && !settings.rotateProxyPerSite) {
    const picked = pickProxy(proxies, proxyCursorRef.value);
    fixedRunProxy = picked.proxy;
    proxyCursorRef.value = picked.nextCursor;
  }

  const evidences = [];
  if (options.onProgress) options.onProgress(`Evidence plan count: ${plans.length}`);
  for (const plan of plans) {
    if (options.onProgress) {
      options.onProgress(
        `Starting plan: field=${plan.field || "unknown"} type=${plan.type} query=${plan.query || plan.url || ""}`
      );
    }
    const evidence = await runPlanWithRetries({
      plan,
      settings,
      proxies,
      proxyCursorRef,
      fixedRunProxy,
      timeoutMs,
      onProgress: options.onProgress
    });
    evidences.push(evidence);
    if (options.onProgress) {
      options.onProgress(
        `Finished plan: field=${plan.field || "unknown"} type=${plan.type} snippet_len=${String(
          evidence?.snippet?.length || 0
        )}`
      );
    }
  }

  return evidences.filter((item) => item && item.snippet);
}

export function buildFieldProbePlan({ input, settings, field, queryTemplate }) {
  const fields = migrateLegacyFields(settings);
  const selectedField = fields.find((item) => item.key === field);
  const defaultTemplateText =
    selectedField?.queryTemplates || settings.profileSerpQueryTemplates || "{{company}} {{city}} {{state}}";
  const templateText = queryTemplate ? String(queryTemplate) : defaultTemplateText;
  return buildPlansFromTemplateText({
    input,
    templateText,
    type: `google_serp_${normalizeFieldKey(field, "probe")}`,
    field
  });
}
