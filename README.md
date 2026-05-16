# Data_Capture_Tool (Node.js)

Prototype REST API + UI to enrich local business data using:
- Playwright (headed browser)
- Qwen 3.5 35B model endpoint on Vast.ai
- Prisma + SQLite

## Features
- `POST /api/enrich` returns strict JSON schema result only.
- `POST /api/enrich-debug` returns result + evidence + metadata for UI.
- `POST /api/debug/model-compatibility-test` runs model compatibility checks.
- `POST /api/debug/field-probe` runs one field-level query probe and returns full debug payload.
- `POST /api/debug/field-probe/start` + `GET /api/debug/field-probe/job/:id` provide live probe progress logs.
- Configurable settings UI (proxy list, retry, session reuse count, cache, timeout).
- Separate owner confidence threshold to improve owner-name recall without loosening all fields.
- `Google SERP Only Mode` (default on): gather evidence from Google SERP text + links, then extract via Qwen.
- Bright Data SERP integration for Google queries (`useBrightDataSerp`), avoiding browser automation blocks.
- Bright Data dual modes: direct `/request` or Datasets v3 (`trigger` + `snapshot` polling) with automatic fallback to `/request`.
- In dataset mode, enrichment runs two-pass extraction per field: `aio_text` first, then compact top-10 organic evidence if needed.
- Bright Data requests use `data_format: "parsed_light"` and pass only compact top-10 organic records to Qwen (smaller prompt).
- Separate timeout controls: `modelRequestTimeoutMs` and `evidenceRequestTimeoutMs` for easier tuning.
- Low-latency controls: disable model thinking, set reasoning effort, and cap max tokens per task.
- Per-field SERP query templates (`owner`, `competitor`, `service`, `profile`) editable in UI.
- Debug visibility for enrichment: prompt sent to Qwen, raw model response, and Bright Data raw preview.
- Evidence capture from allowed sources: company site, Google Maps, Yelp, LinkedIn, BBB.
- Cache by `company + city + state + website` with configurable TTL.

## Input schema (`POST /api/enrich`)
```json
{
  "company": "Acme Plumbing",
  "city": "Austin",
  "state": "TX",
  "website": "https://acmeplumbing.example"
}
```

`custom_1` is also accepted as an alias for `state`.

## Output schema (`POST /api/enrich`)
```json
{
  "owner_firstname": null,
  "closest_competitor": null,
  "top_service": null
}
```

## Run
1. Install deps
```bash
npm install
```

2. Create env file
```bash
cp .env.example .env
```

3. Generate Prisma client
```bash
npm run prisma:generate
```

4. Start
```bash
npm run dev
```

Open UI: `http://localhost:8787`

Notes:
- DB tables are auto-created at startup in v1 prototype.
- If your model endpoint is protected, set either `MODEL_API_KEY` or `MODEL_BASIC_AUTH` (`user:pass`).
- For Bright Data, set `BRIGHT_DATA_API_TOKEN` and `BRIGHT_DATA_ZONE` (example zone: `serp_api1`).
- Use the UI `Compatibility Tests` panel to verify model JSON/schema behavior before live enrich runs.

## Deploy On Model Server (One-Liner)
1. Clone + install + run (single command):
```bash
git clone <YOUR_GITHUB_REPO_URL> data_capture_tool && cd data_capture_tool && bash scripts/install-run.sh 8787
```

2. Open:
- UI: `http://<SERVER_IP>:8787`
- Public docs: `http://<SERVER_IP>:8787/api/public/docs`
- OpenAPI JSON: `http://<SERVER_IP>:8787/api/public/openapi.json`

## Push To GitHub
If this folder is not yet a git repo:
```bash
git init
git add .
git commit -m "Initial commit: Data_Capture_Tool with public dynamic API"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```
