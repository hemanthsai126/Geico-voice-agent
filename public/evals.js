import {
  attachChartInteractions,
  buildAggregate,
  chartCard,
  collectAllToolFailures,
  displayProviderName,
  displayModelName,
  escapeHtml,
  formatMs,
  formatOffset,
  formatScore,
  groupedBarChart,
  histogramChart,
  lineChart,
  loadConversationEvals,
  metricCard,
  metricHelp,
  stackedHistogramPanels,
  summarizeToolArgs,
} from "./evalMetrics.js";

const evalSummaryEl = document.querySelector("#evalSummary");
const evalChartsEl = document.querySelector("#evalCharts");
const evalDetailsEl = document.querySelector("#evalDetails");
const refreshButton = document.querySelector("#refreshEvalsButton");
const evalProviderBadge = document.querySelector("#evalProviderBadge");
const evalPageTitle = document.querySelector("#evalPageTitle");
const evalPageDescription = document.querySelector("#evalPageDescription");
const providerFilter = providerFromPath();

refreshButton.addEventListener("click", loadEvals);
configureProviderHeader();
await loadEvals();

async function loadEvals() {
  evalSummaryEl.textContent = "Loading eval dashboard...";
  evalChartsEl.textContent = "";
  evalDetailsEl.textContent = "";

  try {
    const allEvals = await loadConversationEvals();
    const evals = providerFilter
      ? allEvals.filter((item) => (item.voiceModel?.provider ?? "openai") === providerFilter)
      : allEvals;
    if (evals.length === 0) {
      evalSummaryEl.innerHTML = `<section class="card"><p>No ${escapeHtml(providerLabel(providerFilter))} conversations saved yet.</p></section>`;
      evalDetailsEl.textContent = providerFilter
        ? `Record a conversation using ${providerLabel(providerFilter)}, then refresh this page.`
        : "Complete a call, press Stop, then refresh this page.";
      return;
    }

    const chronological = withChronologicalOrdinals(evals);
    renderExecutiveSummary(chronological);
    renderCharts(chronological);
    renderEvalDetailSections(chronological);
    attachChartInteractions(document);
  } catch (error) {
    evalSummaryEl.textContent = error instanceof Error ? error.message : "Failed to load evals.";
  }
}

function providerFromPath() {
  const match = window.location.pathname.match(/^\/evals\/(openai|grok|gemini)$/);
  return match?.[1];
}

function configureProviderHeader() {
  const label = providerLabel(providerFilter);
  if (!providerFilter) {
    evalProviderBadge.textContent = "Evaluation dashboard";
    evalPageTitle.textContent = "All Agent Evals";
    evalPageDescription.textContent =
      "Overall production-style dashboard for latency, correction, tool, and RAG quality metrics across all saved conversations.";
    return;
  }

  evalProviderBadge.textContent = `${label} evaluation dashboard`;
  evalPageTitle.textContent = `${label} Evals`;
  evalPageDescription.textContent =
    `Provider-specific dashboard for latency, correction, tool, and RAG quality metrics across ${label} conversations only.`;
}

function providerLabel(provider) {
  if (provider === "grok") return "Grok";
  if (provider === "gemini") return "Gemini";
  if (provider === "openai") return "OpenAI";
  return "saved";
}

/** Oldest conversation is #1 so chart X-axis order matches scorecard rows. Mutates items with listOrdinal. */
function withChronologicalOrdinals(evals) {
  const chronological = [...evals].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  chronological.forEach((item, i) => {
    item.listOrdinal = i + 1;
  });
  return chronological;
}

function renderExecutiveSummary(evals) {
  const aggregate = buildAggregate(evals);
  evalSummaryEl.innerHTML = [
    metricCard("Saved Conversations", aggregate.conversations, metricHelp.totalConversations),
    metricCard("Avg Response Start", formatMs(aggregate.avgFirstAudioLatencyMs), metricHelp.averageResponseStart),
    metricCard("Avg Response Complete", formatMs(aggregate.avgFinalTranscriptLatencyMs), metricHelp.averageResponseComplete),
    metricCard("Avg Tool Runtime", formatMs(aggregate.avgToolDurationMs), metricHelp.averageToolDuration),
    metricCard("Avg RAG Runtime", formatMs(aggregate.avgRagLatencyMs), metricHelp.averageRagLatency),
    metricCard("Field Corrections", aggregate.corrections, metricHelp.corrections),
    metricCard(
      "Tool Failures",
      aggregate.silentFailures,
      aggregate.silentFailures ? `${metricHelp.silentFailures} See the Tool failure log below.` : metricHelp.silentFailures,
    ),
    metricCard("Avg RAG Best Match", formatScore(aggregate.avgRagTopScore), metricHelp.ragTopScore),
    metricCard("Avg RAG Result Score", formatScore(aggregate.avgRagResultScore), "Average cosine score across returned RAG results."),
  ].join("");
}

function renderCharts(evals) {
  evalChartsEl.innerHTML = [
    chartCard(
      "Response Latency Over Time",
      "How quickly Lizzy starts speaking and completes the response after the user finishes a turn.",
      lineChart(
        [
          {
            label: "Response start",
            values: evals.map((item) => item.avgFirstAudioLatencyMs),
            color: "#5a8aaa",
          },
          {
            label: "Response complete",
            values: evals.map((item) => item.avgFinalTranscriptLatencyMs),
            color: "#111827",
          },
        ],
        evals,
        formatMs,
        {
          xLabel: "Conversation number (oldest→newest)",
          yLabel: "Latency in milliseconds/seconds",
        },
      ),
    ),
    chartCard(
      "Tool vs RAG latency per conversation",
      "Two stacked histograms: each builds its buckets from only one metric, so milliseconds on the horizontal axis mean something different above vs below. Bar height remains how many saved conversations fall in each latency slice. This avoids mixing unlike distributions into shared bins—or reading two drifting line charts like a paired time series.",
      stackedHistogramPanels([
        {
          title: "Average tool wall time",
          body: histogramChart(
            [
              {
                label: "Conversations",
                values: evals.map((item) => Number(item.avgToolDurationMs ?? 0)),
                color: "#87afc7",
              },
            ],
            formatMs,
            {
              binMode: "linear",
              binCount: 8,
              linearBinLabelStyle: "midpoint",
              slotMinPx: 44,
              chartHeightPx: 200,
              omitChartLegend: true,
              chartAxisLegendStack: true,
              denseAxisLabels: false,
              ariaLabel: "Histogram of per-conversation average tool wall time",
              xLabel:
                "Equal-width bins across the slow→fast spread in this metric. Ticks mark each bin midpoint; hover a tick or bar for the exact millisecond span.",
              yLabel: "Conversation count per bin",
            },
          ),
        },
        {
          title: "Average RAG retrieval latency",
          body: histogramChart(
            [
              {
                label: "Conversations",
                values: evals.map((item) => Number(item.ragLatencyMs ?? 0)),
                color: "#1e2030",
              },
            ],
            formatMs,
            {
              binMode: "linear",
              binCount: 8,
              linearBinLabelStyle: "midpoint",
              slotMinPx: 44,
              chartHeightPx: 200,
              omitChartLegend: true,
              chartAxisLegendStack: true,
              denseAxisLabels: false,
              ariaLabel: "Histogram of per-conversation average RAG retrieval latency",
              xLabel:
                "Equal-width bins across the slow→fast spread in this metric. Ticks mark each bin midpoint; hover a tick or bar for the exact millisecond span.",
              yLabel: "Conversation count per bin",
            },
          ),
        },
      ]),
    ),
    chartCard(
      "Corrections Per Conversation",
      "Bar chart of field corrections found in each conversation.",
      groupedBarChart(
        [
          {
            label: "Corrections",
            values: evals.map((item) => item.correctionCount),
            color: "#5a8aaa",
          },
        ],
        evals,
        String,
        {
          numericCategoryWidth: Math.max(40, Math.round(480 / Math.max(evals.length, 1))),
          xLabel: "Conversation number (oldest→newest)",
          yLabel: "Correction count",
        },
      ),
    ),
    chartCard(
      "RAG Retrieval Quality Distribution",
      "Histogram of best cosine match and conversation-level average cosine across returned chunks. Helps spot tight clusters versus long tails. Buckets aggregate many conversations, so bar clicks cannot open one call — use Response Latency Over Time (click a dot) or Corrections Per Conversation (click a bar) instead.",
      histogramChart(
        [
          {
            label: "Best match score",
            values: evals.map((item) => Number(item.ragTopScore ?? 0)),
            color: "#5a8aaa",
          },
          {
            label: "Average chunk score",
            values: evals.map((item) => Number(item.ragAverageResultScore ?? 0)),
            color: "#87afc7",
          },
        ],
        formatScore,
        {
          binMode: "linear",
          binCount: 10,
          linearBinLabelStyle: "midpoint",
          slotMinPx: 46,
          denseAxisLabels: false,
          chartAxisLegendStack: true,
          xLabel:
            "Pooled similarity samples for both series. Ticks are bin midpoints; hover a tick or bar for the exact score interval.",
          yLabel: "Conversation count per bin",
        },
      ),
    ),
  ].join("");
}

function renderEvalDetailSections(evals) {
  const failureRows = collectAllToolFailures(evals);
  evalDetailsEl.innerHTML = `
    ${renderToolFailureLogSection(failureRows)}
    ${renderConversationScorecardSection(evals)}
  `;
}

function renderToolFailureLogSection(failureRows) {
  const headline = `${failureRows.length} failure${failureRows.length === 1 ? "" : "s"} across saved conversations`;
  const intro =
    failureRows.length === 0
      ? `This list only shows tool runs that returned <code class="metric-code-snippet">output.ok === false</code>. Nothing in the conversations you’re viewing matched that—you can still open any call below to review transcripts, audio, and tool payloads in its scorecard.`
      : `Rows are tool executions where <code class="metric-code-snippet">output.ok === false</code> (${escapeHtml(headline)}). Open a conversation’s eval detail for transcripts, audio cues, and full tool payloads next to each failure.`;

  return `
    <section class="card" id="eval-tool-failure-log">
      <div class="dashboard-section-header">
        <p class="badge">Tool diagnostics</p>
        <h2>Tool Failure Log</h2>
        <p>${intro}</p>
      </div>
      ${
        failureRows.length === 0
          ? `<p class="status"><strong>All clear.</strong> No failures matched this dashboard filter.</p>`
          : `<div class="eval-failure-log-scroll">${failureRows.map(renderToolFailureRow).join("")}</div>`
      }
    </section>
  `;
}

function renderToolFailureRow(row) {
  const { conversationId, displayId, listOrdinal, customerName, startedAt, failure } = row;
  const argsSummary = summarizeToolArgs(failure.args);
  const hrefInspect = `/evals/conversation?id=${encodeURIComponent(conversationId)}#quality-events`;
  const ts = escapeHtml(formatOffset(failure.timestampMs));
  const err = escapeHtml(formatToolFailureReason(failure.error));
  const name = escapeHtml(failure.name ?? "unknown_tool");
  return `
    <article class="eval-failure-log-row">
      <div class="eval-failure-log-main">
        <div class="eval-failure-log-meta">
          <strong>${escapeHtml(String(listOrdinal ?? displayId ?? ""))}</strong>
          <span>${escapeHtml(customerName ?? "")}</span>
          <small>${escapeHtml(startedAt ? new Date(startedAt).toLocaleString() : "—")}</small>
          <small class="eval-failure-offset">@${ts} audio</small>
        </div>
        <div class="eval-failure-log-body">
          <p class="eval-failure-tool"><span class="eyebrow">Tool</span> <code>${name}</code></p>
          <p class="eval-failure-reason"><span class="eyebrow">Reason</span> ${err}</p>
          ${
            argsSummary
              ? `<p class="eval-failure-args"><span class="eyebrow">Inputs</span> ${escapeHtml(argsSummary)}</p>`
              : ""
          }
        </div>
      </div>
      <div class="eval-failure-log-actions">
        <a class="button-link primary" href="${hrefInspect}">Inspect</a>
        ${
          failure.args
            ? `<details class="eval-failure-json"><summary>Show JSON</summary><pre class="tool-payload">${escapeHtml(JSON.stringify(failure.args, null, 2))}</pre></details>`
            : ""
        }
      </div>
    </article>
  `;
}

function formatToolFailureReason(errorValue) {
  if (errorValue == null || errorValue === "") return "Unknown error.";
  if (typeof errorValue === "string") return errorValue;
  if (typeof errorValue === "object" && typeof errorValue.message === "string") return errorValue.message;
  try {
    return JSON.stringify(errorValue);
  } catch {
    return String(errorValue);
  }
}

function renderConversationScorecardSection(evals) {
  return `
    <section class="card">
      <div class="dashboard-section-header">
        <div>
          <p class="badge">Conversation drilldown</p>
          <h2>Conversation Scorecards</h2>
          <p>Open a conversation to inspect per-call latency, corrections, tool behavior, and RAG evidence.</p>
        </div>
      </div>
      <div class="eval-scorecard-scroll">
        <table class="eval-scorecard-table">
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Conversation</th>
              <th scope="col">Model</th>
              <th scope="col" class="numeric">Response start</th>
              <th scope="col" class="numeric">Tool runtime</th>
              <th scope="col" class="numeric">Failures</th>
              <th scope="col" class="numeric">Corrections</th>
              <th scope="col" class="numeric">RAG best match</th>
              <th scope="col" class="action">Open</th>
            </tr>
          </thead>
          <tbody>
            ${evals.map(renderConversationRow).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderConversationRow(item) {
  return `
    <tr>
      <td><strong>${escapeHtml(String(item.listOrdinal ?? item.displayId))}</strong></td>
      <td>
        <div class="eval-scorecard-primary">${escapeHtml(item.customerName)}</div>
        <div class="eval-scorecard-sub">${escapeHtml(item.mode)} · ${escapeHtml(new Date(item.startedAt).toLocaleString())}</div>
      </td>
      <td>
        <div class="eval-scorecard-primary">${escapeHtml(displayProviderName(item.voiceModel?.provider))}</div>
        <div class="eval-scorecard-sub">${escapeHtml(displayModelName(item.voiceModel?.model ?? ""))}</div>
      </td>
      <td class="numeric">${escapeHtml(formatMs(item.avgFirstAudioLatencyMs))}</td>
      <td class="numeric">${escapeHtml(formatMs(item.avgToolDurationMs))}</td>
      <td class="numeric">${escapeHtml(String(item.silentFailureCount))}</td>
      <td class="numeric">${escapeHtml(String(item.correctionCount))}</td>
      <td class="numeric">${escapeHtml(formatScore(item.ragTopScore))}</td>
      <td class="action"><a class="button-link" href="/evals/conversation?id=${encodeURIComponent(item.id)}">Details</a></td>
    </tr>
  `;
}
