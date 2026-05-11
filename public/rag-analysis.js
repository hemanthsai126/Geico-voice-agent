import { analyzeRagFromConversationEvals, chartCard, escapeHtml, loadConversationEvals, metricCard } from "./evalMetrics.js";

const PAGE_BAR_TOP_N = 20;

const ragSummaryEl = document.querySelector("#ragSummary");
const ragChartsEl = document.querySelector("#ragCharts");
const refreshButton = document.querySelector("#refreshRagAnalysisButton");
const ragProviderBadge = document.querySelector("#ragProviderBadge");
const ragPageTitle = document.querySelector("#ragPageTitle");
const ragPageDescription = document.querySelector("#ragPageDescription");
const providerFilter = providerFromPath();

refreshButton?.addEventListener("click", loadPage);
configureProviderHeader();
await loadPage();

function providerFromPath() {
  const match = window.location.pathname.match(/^\/rag-analysis\/(openai|grok|gemini)$/);
  return match?.[1];
}

function configureProviderHeader() {
  const label = providerLabel(providerFilter);
  if (!providerFilter) {
    ragProviderBadge.textContent = "RAG retrieval";
    ragPageTitle.textContent = "RAG Retrieval Analysis";
    ragPageDescription.textContent =
      "How often each GEICO knowledge page shows up when the semantic search tool returns snippets—from saved conversations only.";
    return;
  }

  ragProviderBadge.textContent = `${label} · RAG`;
  ragPageTitle.textContent = `${label} · RAG analysis`;
  ragPageDescription.textContent = `Scoped to conversations recorded with ${label}.`;
}

function providerLabel(provider) {
  if (provider === "grok") return "Grok";
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  return "saved";
}

async function loadPage() {
  ragSummaryEl.textContent = "Loading saved conversations…";
  ragChartsEl.textContent = "";

  try {
    const allEvals = await loadConversationEvals();
    const filtered = providerFilter ? allEvals.filter((item) => (item.voiceModel?.provider ?? "openai") === providerFilter) : allEvals;
    const chronological = [...filtered].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    chronological.forEach((item, index) => {
      item.listOrdinal = index + 1;
    });

    if (chronological.length === 0) {
      ragSummaryEl.innerHTML = `<section class="card"><p>No ${escapeHtml(providerLabel(providerFilter))} conversations saved yet.</p></section>`;
      return;
    }

    const analysis = analyzeRagFromConversationEvals(chronological);

    if (analysis.totalRagInvocations === 0) {
      ragSummaryEl.innerHTML = `<section class="card"><p>No <code class="metric-code-snippet">search_auto_insurance_knowledge</code> calls in this view.</p></section>`;
      return;
    }

    ragSummaryEl.innerHTML = summaryMetrics(analysis);

    ragChartsEl.innerHTML = renderPageUsageBarChart(analysis);
  } catch (error) {
    ragSummaryEl.textContent = error instanceof Error ? error.message : "Failed to load analysis.";
  }
}

function summaryMetrics(a) {
  const pagesUsed = a.documentStats.filter((row) => row.hits > 0).length;
  const eff = a.concentration?.effectiveDocs;
  const top = a.documentStats[0];

  const failureNote =
    a.failedRagCalls > 0
      ? `<p class="rag-footnote">${escapeHtml(String(a.failedRagCalls))} search call(s) failed (<code class="metric-code-snippet">ok !== true</code>).</p>`
      : "";

  const cards = [
    metricCard("Knowledge searches", String(a.totalRagInvocations), "Times the GEICO semantic search tool ran in this slice."),
    metricCard("Snippet rows returned", String(a.totalResultPositions), "Total chunks handed to the model across those searches."),
    metricCard(
      "Pages that appeared",
      String(pagesUsed),
      `Distinct GEICO URLs (pathname) in snippet results; the tallest bar labels the busiest page.`,
    ),
    metricCard(
      "Spread of usage",
      eff !== undefined ? eff.toFixed(1) : "n/a",
      top?.shareOfHits != null && top.shareOfHits > 0
        ? `Larger reads as citations spread across more pathnames evenly. About ${Math.round(top.shareOfHits * 100)}% of snippets are from ${shortLabel(top.displayLabel, 48)}.`
        : `Larger reads as citations spread across more pathnames evenly.`,
    ),
  ].join("");

  return `<div class="eval-summary-grid">${cards}</div>${failureNote}`;
}

function renderPageUsageBarChart(a) {
  const rows = [...a.documentStats].sort((x, y) => y.hits - x.hits).slice(0, PAGE_BAR_TOP_N);
  if (!rows.length) {
    return chartCard("Pages used", "Snippet counts per GEICO page.", `<p class="status">No source rows in saved payloads.</p>`);
  }

  const maxHits = Math.max(1, rows[0].hits);
  const totalSnippets = a.totalResultPositions || rows.reduce((s, r) => s + r.hits, 0);

  const body = rows
    .map((row) => {
      const pct = (row.hits / maxHits) * 100;
      const pctOfAll = totalSnippets ? (row.hits / totalSnippets) * 100 : 0;
      const title = escapeHtml(row.groupKey);
      const label = escapeHtml(shortLabel(row.displayLabel, 100));
      return `
      <div class="rag-page-bar-row">
        <span class="rag-page-bar-label"><span title="${title}">${label}</span></span>
        <div class="rag-page-bar-track" aria-hidden="true"><div class="rag-page-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="rag-page-bar-count">${escapeHtml(String(row.hits))}<small>${escapeHtml(pctOfAll.toFixed(0))}%</small></span>
      </div>`;
    })
    .join("");

  const more = a.documentStats.length > PAGE_BAR_TOP_N ? ` Showing top ${PAGE_BAR_TOP_N}; ${a.documentStats.length} pages total.` : "";

  return chartCard(
    "Pages referenced in answers",
    `Each horizontal bar counts how often a page contributed at least one snippet when the agent answered GEICO coverage questions.${more} Rows are merged by URL pathname (case-insensitive).`,
    `<div class="rag-page-bar-chart">${body}</div>`,
  );
}

function shortLabel(text, max) {
  const s = String(text ?? "").trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
