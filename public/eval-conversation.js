import {
  attachChartInteractions,
  buildConversationEval,
  chartCard,
  escapeHtml,
  eventPlayTimestampMs,
  formatDate,
  formatMs,
  formatOffset,
  formatPercent,
  formatScore,
  groupedBarChart,
  lineChart,
  metricCard,
  metricHelp,
  displayVoiceModel,
  simpleIntegerBar,
} from "./evalMetrics.js";

const titleEl = document.querySelector("#conversationTitle");
const descriptionEl = document.querySelector("#conversationDescription");
const summaryEl = document.querySelector("#conversationSummary");
const chartsEl = document.querySelector("#conversationCharts");
const detailsEl = document.querySelector("#conversationDetails");
const reviewEl = document.querySelector("#conversationReview");

/** Populated when a conversation loads (chart clicks map latency ↔ transcript + audio). */
let conversationEvalLoaded = null;

await loadConversationEval();

/**
 * Rows that drove `evals.responseLatencies` ordering (one sample per finalized user→agent reply).
 */
function transcriptEntryIsUserTurn(entry) {
  const sr = String(entry?.sourceRole ?? "").toLowerCase();
  if (sr === "user" || sr === "customer") return true;
  if (sr === "agent" || sr === "assistant") return false;
  const speaker = String(entry?.speaker ?? entry?.role ?? "").toLowerCase();
  if (speaker.includes("lizzy") || speaker === "assistant" || speaker === "agent") return false;
  return Boolean(String(entry?.text ?? "").trim());
}

/** @returns {number[]} transcript indices in order (customer turns only). */
function userTurnTranscriptIndices(conversation) {
  const rows = conversation?.transcripts ?? [];
  return rows.map((entry, ix) => (transcriptEntryIsUserTurn(entry) ? ix : -1)).filter((ix) => ix >= 0);
}

function transcriptEntryIsAgentTurn(entry) {
  const sr = String(entry?.sourceRole ?? "").toLowerCase();
  if (sr === "agent" || sr === "assistant") return true;
  const speaker = String(entry?.speaker ?? entry?.role ?? "").toLowerCase();
  return speaker.includes("lizzy") || speaker === "assistant" || speaker === "agent";
}

/** First Lizzy/agent transcript row strictly after this customer row (same reply cycle). */
function indexOfAgentReplyAfter(transcripts, customerIdx) {
  if (!Array.isArray(transcripts) || customerIdx < 0) return undefined;
  for (let i = customerIdx + 1; i < transcripts.length; i++) {
    const e = transcripts[i];
    if (transcriptEntryIsUserTurn(e)) return undefined;
    if (transcriptEntryIsAgentTurn(e)) return i;
  }
  return undefined;
}

/**
 * Customer transcript row index → latency chart index.
 * Prefer `userTimestampMs === transcripts[].timestampMs` because merged STT fragments can add extra user rows
 * while latency keeps the anchor from the first `recordUserTurn` for that pending turn.
 */
function latencyTurnAnchors(conversation) {
  const latencies = conversation?.evals?.responseLatencies ?? [];
  const transcripts = conversation?.transcripts ?? [];
  const userIx = userTurnTranscriptIndices(conversation);
  /** @type {Map<number, number>} */
  const byTranscript = new Map();

  latencies.forEach((lat, latencyIdx) => {
    const anchorMs = Number(lat.userTimestampMs ?? NaN);
    let transcriptIdx;

    if (Number.isFinite(anchorMs)) {
      const hit = transcripts.findIndex(
        (entry, ix) => transcriptEntryIsUserTurn(entry) && Number(entry.timestampMs ?? 0) === anchorMs,
      );
      if (hit >= 0) transcriptIdx = hit;
    }
    if (transcriptIdx === undefined) {
      transcriptIdx = userIx[latencyIdx];
    }

    if (transcriptIdx !== undefined && transcriptIdx >= 0) {
      byTranscript.set(transcriptIdx, latencyIdx);
    }
  });

  return byTranscript;
}

/** latency chart index → transcript indices for customer + Lizzy reply */
function latencyExchangePairs(conversation) {
  const anchors = latencyTurnAnchors(conversation);
  const transcripts = conversation?.transcripts ?? [];
  /** @type {Map<number, { customerIx: number; agentIx?: number }>} */
  const out = new Map();

  for (const [customerIx, latencyIx] of anchors) {
    const agentIx = indexOfAgentReplyAfter(transcripts, customerIx);
    out.set(latencyIx, { customerIx, agentIx });
  }

  return out;
}

/** transcript row index → { latencyIx, side } for Conversation Review markup */
function latencyExchangeRowTags(conversation) {
  const pairs = latencyExchangePairs(conversation);
  /** @type {Map<number, { latencyIx: number; side: "customer" | "lizzy" }>} */
  const byRow = new Map();

  for (const [latencyIx, pair] of pairs) {
    byRow.set(pair.customerIx, { latencyIx, side: "customer" });
    if (pair.agentIx !== undefined) {
      byRow.set(pair.agentIx, { latencyIx, side: "lizzy" });
    }
  }

  return byRow;
}

function latencySeekMs(conversation, latencyIdx, seriesSlug) {
  const latencies = conversation?.evals?.responseLatencies ?? [];
  const lat = latencies[latencyIdx];
  if (!lat) return 0;

  const base = Math.max(0, Number(lat.userTimestampMs ?? 0));
  const fa = Math.max(0, Number(lat.firstAudioLatencyMs ?? 0));
  const ftRaw = Number(lat.finalTranscriptLatencyMs ?? NaN);
  const ft = Number.isFinite(ftRaw) ? Math.max(0, ftRaw) : fa;

  if (seriesSlug === "lizzy-reply-done") return base + ft;
  if (seriesSlug === "lizzy-first-audio") return base + fa;
  return base;
}

function highlightTranscriptForLatencyTurn(latencyTurnIndex, options = {}) {
  const seekAudio = options.seekAudio !== false;
  const seriesSlug = options.seriesSlug ?? "";
  const conversation = options.conversation ?? conversationEvalLoaded;

  if (!reviewEl || !Number.isFinite(latencyTurnIndex)) return;

  reviewEl.querySelectorAll("[data-latency-exchange]").forEach((el) => {
    el.classList.remove("latency-exchange-highlight-customer", "latency-exchange-highlight-lizzy");
  });

  const targets = reviewEl.querySelectorAll(`[data-latency-exchange="${latencyTurnIndex}"]`);
  if (!targets.length) return;

  targets.forEach((el) => {
    const side = el.dataset.latencySide;
    el.classList.add(
      side === "lizzy" ? "latency-exchange-highlight-lizzy" : "latency-exchange-highlight-customer",
    );
  });

  const scrollTarget =
    reviewEl.querySelector(`[data-latency-exchange="${latencyTurnIndex}"][data-latency-side="customer"]`) ??
    targets[0];

  const scrollRoot = reviewEl.querySelector(".eval-inline-transcript");
  if (scrollRoot && typeof scrollRoot.scrollTo === "function") {
    const rootRect = scrollRoot.getBoundingClientRect();
    const box = scrollTarget.getBoundingClientRect();
    const deltaTop = box.top - rootRect.top + scrollRoot.scrollTop;
    const padding = Math.min(112, Math.max(40, scrollRoot.clientHeight * 0.28));
    scrollRoot.scrollTo({ top: Math.max(0, deltaTop - padding), behavior: "smooth" });
  } else {
    scrollTarget.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  if (!seekAudio || !conversation) return;

  const ms = latencySeekMs(conversation, latencyTurnIndex, seriesSlug);
  const audioEl = document.querySelector("#evalInlineConversationAudio");
  if (!audioEl || !Number.isFinite(ms)) return;

  audioEl.currentTime = ms / 1000;
  if (typeof audioEl.play === "function") {
    audioEl.play().catch(() => {});
  }
}

function onLatencyChartNavigateToTurn(event) {
  const el = event.target;
  if (!(el instanceof Element)) return;
  const point = el.closest("circle.chart-point");
  if (!point || !point.closest("[data-latency-turn-chart]")) return;

  const rawIdx = point.getAttribute("data-response-latency-index");
  if (rawIdx === null || rawIdx === "") return;

  const latencyTurnIndex = Number(rawIdx);
  if (!Number.isFinite(latencyTurnIndex)) return;

  const seriesSlug = point.getAttribute("data-series") ?? "";

  highlightTranscriptForLatencyTurn(latencyTurnIndex, {
    seekAudio: true,
    seriesSlug,
    conversation: conversationEvalLoaded,
  });
}

if (chartsEl) {
  chartsEl.addEventListener("click", onLatencyChartNavigateToTurn);
}

async function loadConversationEval() {
  const id = new URLSearchParams(window.location.search).get("id");
  if (!id) {
    summaryEl.innerHTML = `<section class="card"><p>Missing conversation id.</p></section>`;
    return;
  }

  const response = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
  const data = await response.json();
  if (!response.ok) {
    summaryEl.innerHTML = `<section class="card"><p>${escapeHtml(data.error ?? "Conversation not found.")}</p></section>`;
    return;
  }

  conversationEvalLoaded = data.conversation;
  const item = buildConversationEval(data.conversation);
  titleEl.textContent = item.customerName;
  descriptionEl.textContent = `${item.mode} conversation started ${formatDate(item.startedAt)} using ${displayVoiceModel(item.voiceModel)}.`;
  renderSummary(item);
  renderCharts(item);
  renderDetails(item, data.audio);
  renderConversationReview(data.conversation, data.audio);
  attachChartInteractions(document);
  attachAudioJumpHandlers();
  attachTranscriptAudioHandlers();
  if (window.location.hash === "#quality-events") {
    document.querySelector("#quality-events")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderSummary(item) {
  summaryEl.innerHTML = [
    metricCard("Response Start Latency", formatMs(item.avgFirstAudioLatencyMs), metricHelp.averageResponseStart),
    metricCard("Response Complete Latency", formatMs(item.avgFinalTranscriptLatencyMs), metricHelp.averageResponseComplete),
    metricCard("Average Tool Runtime", formatMs(item.avgToolDurationMs), metricHelp.averageToolDuration),
    metricCard("RAG Runtime", formatMs(item.ragLatencyMs), metricHelp.averageRagLatency),
    metricCard("Field Corrections", item.correctionCount, metricHelp.corrections),
    metricCard("Tool Failures", item.silentFailureCount, metricHelp.silentFailures),
    metricCard("RAG Best Match Score", formatScore(item.ragTopScore), metricHelp.ragTopScore),
    metricCard("Avg RAG Result Score", formatScore(item.ragAverageResultScore), "Average cosine score across returned RAG results."),
    metricCard("Low Confidence RAG Calls", item.ragLowConfidenceCount, metricHelp.lowConfidenceRag),
  ].join("");
}

function renderCharts(item) {
  const knowledgePoints = item.ragCalls.map((call, index) => ({
    ...item,
    chartLabel: call.timestampMs !== undefined ? formatOffset(call.timestampMs) : `RAG${index + 1}`,
    label: `RAG${index + 1}`,
    avgToolDurationMs: call.durationMs,
    ragLatencyMs: call.output?.ragLatencyMs,
  }));

  const responsePoints = item.responseLatencies.map((latency, index) => ({
    ...item,
    chartLabel: formatOffset(latency.userTimestampMs),
    /** Marks the saved customer-turn anchor on the timeline (see app.js recordUserTurn / userTimestampMs). */
    label: `Customer turn ${index + 1}`,
    axisDenseTitle: `${formatOffset(latency.userTimestampMs)} · Customer utterance ${index + 1} on the recording. Lizzy latency is measured from after this customer turn onward: stopwatch starts when the browser captures that turn.`,
    startedAt: item.startedAt,
    avgFirstAudioLatencyMs: latency.firstAudioLatencyMs,
    avgFinalTranscriptLatencyMs: latency.finalTranscriptLatencyMs,
  }));

  const toolUsagePoints = Object.entries(item.toolUsageByName).map(([name, count]) => ({
    ...item,
    chartLabel: name,
    label: name.length > 42 ? `${name.slice(0, 40)}…` : name,
    count,
  }));

  const ragAvgPoints = item.ragCallScoreStats.map((stat) => ({
    ...item,
    chartLabel: stat.timestampMs !== undefined ? formatOffset(stat.timestampMs) : stat.label,
    label: stat.label,
    averageScore: stat.averageScore,
  }));

  const responseLatencyChartInner = responsePoints.length
    ? lineChart(
        [
          {
            label: "Lizzy · first audio",
            values: responsePoints.map((point) => point.avgFirstAudioLatencyMs),
            color: "#5a8aaa",
          },
          {
            label: "Lizzy · reply done",
            values: responsePoints.map((point) => point.avgFinalTranscriptLatencyMs),
            color: "#111827",
          },
        ],
        responsePoints,
        formatMs,
        {
          compressLatencyYAxis: true,
          plotWidthMinPx: 320,
          chartHeightPx: 238,
          /** More space per slot so sideways scroll stays readable alongside compact axis labels */
          slotMinPx: Math.min(72, Math.max(48, Math.round(820 / Math.max(responsePoints.length, 1)))),
          /** Leaves room below the peak; hover dots still report exact latency */
          yAxisNiceMul: 1.16,
          plotTopPx: 15,
          /** U1 … = customer utterance index; hover for why Lizzy latencies tie to that anchor */
          denseItemLabelFormatter: (_item, i) => `U${i + 1}`,
          chartAxisLegendStack: true,
          xLabel: "Customer — where this utterance falls on the recording (Lizzy timings are measured afterward)",
          yLabel: "Lizzy — delay after that customer turn (first audible audio vs finished reply)",
        },
      )
    : `<p class="status">No response latency samples captured for this conversation.</p>`;

  const knowledgeTimingChartInner =
    knowledgePoints.length === 0
      ? `<p class="status">No knowledge search tool calls in this conversation.</p>`
      : groupedBarChart(
          [
            {
              label: "Tool runtime",
              values: knowledgePoints.map((point) => point.avgToolDurationMs),
              color: "#87afc7",
            },
            {
              label: "RAG retrieval",
              values: knowledgePoints.map((point) => point.ragLatencyMs),
              color: "#1e2030",
            },
          ],
          knowledgePoints,
          formatMs,
          {
            plotWidthMinPx: 320,
            chartHeightPx: 188,
            numericCategoryWidth: Math.min(86, Math.max(46, Math.round(400 / Math.max(knowledgePoints.length, 1)))),
            xLabel: "Knowledge search calls in time order",
            yLabel: "Runtime in milliseconds/seconds",
          },
        );

  chartsEl.innerHTML = [
    `
    <section class="card chart-card chart-card-latency-combo">
      <div class="latency-combo-intro">
        <h2>Latency &amp; runtime</h2>
        <p>
          The line chart uses the <strong>customer</strong> side for the horizontal axis (saved utterance anchors on the recording). The vertical scale is <strong>Lizzy</strong> (delays after each anchor). Clicking a dot highlights <strong>both</strong> that customer turn and Lizzy&apos;s paired reply in the transcript, and seeks audio toward the matching moment (customer anchor vs measured Lizzy timings depending on which line you clicked). Knowledge search bars are per RAG call (tool wall vs retrieval), not a smoothed line trend.
        </p>
      </div>
      <div class="latency-combo-charts">
        <div class="latency-combo-block" data-latency-turn-chart>
          <h3>Turn-by-turn response latency</h3>
          <p class="latency-chart-hint">Wide runs scroll sideways. <strong>U1, U2 …</strong> = customer anchors on the timeline (not Lizzy). Hover axis labels for details; hover dots for exact Lizzy delays. Click a dot to highlight <strong>both</strong> the customer turn and Lizzy&apos;s reply in Conversation Review. Audio seeks to the anchor plus the latency for whichever series you clicked (blue = first audio, black = reply done).</p>
          ${responseLatencyChartInner}
        </div>
        <div class="latency-combo-block">
          <h3>Knowledge search timing (per call)</h3>
          ${knowledgeTimingChartInner}
        </div>
      </div>
    </section>
    `,
    chartCard(
      "Tool Usage Breakdown",
      "Counts exactly which tools were used in this conversation.",
      toolUsagePoints.length
        ? groupedBarChart(
            [
              {
                label: "Calls",
                values: toolUsagePoints.map((point) => point.count),
                color: "#5a8aaa",
              },
            ],
            toolUsagePoints,
            String,
            {
              plotWidthMinPx: 320,
              chartHeightPx: 176,
              numericCategoryWidth: Math.min(92, Math.max(52, Math.round(380 / Math.max(toolUsagePoints.length, 1)))),
              xLabel: "Tool name",
              yLabel: "Number of calls",
            },
          )
        : `<p class="status">No tool calls captured for this conversation.</p>`,
    ),
    chartCard(
      "RAG average result score per call",
      "For each semantic search, the mean cosine score across returned chunks (bars, not a faux time series).",
      item.ragCallScoreStats.length
        ? groupedBarChart(
            [
              {
                label: "Average cosine",
                values: item.ragCallScoreStats.map((stat) => stat.averageScore),
                color: "#5a8aaa",
              },
            ],
            ragAvgPoints,
            formatScore,
            {
              plotWidthMinPx: 320,
              chartHeightPx: 188,
              numericCategoryWidth: Math.min(
                92,
                Math.max(46, Math.round(420 / Math.max(item.ragCallScoreStats.length, 1))),
              ),
              xLabel: "RAG calls in time order",
              yLabel: "Cosine similarity score",
            },
          )
        : `<p class="status">No RAG tool calls captured for this conversation.</p>`,
    ),
    chartCard("RAG chunks &amp; scores per call", ragDocScoresCaption(), renderRagDocumentScoresPerCallSection(item)),
  ].join("");
}

function ragDocScoresCaption() {
  return "Each block is one search—ranked chunks with cosine score and an at-a-glance bar (replaces multi-line “distribution” charts that implied time on the X axis).";
}

function renderRagDocumentScoresPerCallSection(item) {
  const stats = item.ragCallScoreStats ?? [];
  if (!stats.length) {
    return `<p class="status">No scored RAG payloads to show.</p>`;
  }

  return `
    <div class="rag-doc-scores-stack">
      ${stats
        .map((stat, callIndex) => {
          const headline = stat.timestampMs !== undefined ? formatOffset(stat.timestampMs) : stat.label;
          const docs =
            stat.documents?.length > 0
              ? stat.documents
              : (stat.scores ?? []).map((score, i) => ({
                  rank: i + 1,
                  score,
                  docLabel: `Result ${i + 1}`,
                }));
          return `
            <section class="rag-doc-call-block">
              <header class="rag-doc-call-header">
                <strong>${escapeHtml(stat.label ?? `RAG${callIndex + 1}`)}</strong>
                <span class="rag-doc-call-time">${escapeHtml(headline)}</span>
                ${stat.query ? `<p class="rag-doc-query">${escapeHtml(String(stat.query))}</p>` : ""}
              </header>
              ${
                docs.length
                  ? `<ul class="rag-doc-row-list">
                      ${docs
                        .map((doc) => {
                          const pct = Math.round(Math.min(Math.max(Number(doc.score ?? 0), 0), 1) * 1000) / 10;
                          return `
                        <li class="rag-doc-row">
                          <div class="rag-doc-row-meta">
                            <span class="rag-doc-rank">#${doc.rank}</span>
                            <span class="rag-doc-label" title="${escapeHtml(doc.docLabel)}">${escapeHtml(doc.docLabel)}</span>
                            <span class="rag-doc-score-chip">${escapeHtml(formatScore(doc.score))}</span>
                          </div>
                          <div class="rag-doc-score-bar-track" aria-hidden="true">
                            <div class="rag-doc-score-bar-fill" style="width:${pct}%"></div>
                          </div>
                        </li>`;
                        })
                        .join("")}
                    </ul>`
                  : `<p class="status">No cosine-scored chunks recorded for this query.</p>`
              }
            </section>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderDetails(item, audio) {
  detailsEl.innerHTML = `
    <section id="quality-events" class="card">
      <div class="dashboard-section-header">
        <p class="badge">Transcript evidence</p>
        <h2>Corrections & Tool Failures</h2>
        <p>
          The time shown is when the tool captured the change or error. <strong>Play from start</strong> jumps to the estimated start of that customer speech (using the live turn clock when available, otherwise a speech-length rewind and nearby field updates). Old conversations use a best-effort rewind.
        </p>
      </div>
      <div class="quality-events-summary-slot">
        ${simpleIntegerBar(item.correctionCount, {
          caption: "Corrections in this conversation",
          ariaLabel: `${item.correctionCount} corrections recorded for this transcript section`,
          minScale: 4,
        })}
      </div>
      <div class="floating-audio-player eval-audio-player">
        <div>
          <span class="eyebrow">Conversation audio</span>
          <strong>Jump to an eval event</strong>
        </div>
        <audio id="evalConversationAudio" controls src="${escapeHtml(audio?.conversation ?? "")}"></audio>
      </div>
      <div class="quality-event-grid">
        ${renderQualityGroup("Corrections", item.corrections, renderCorrectionEvent)}
        ${renderQualityGroup("Tool Failures", item.toolFailures, renderToolFailureEvent)}
      </div>
    </section>

    <section class="card">
      <div class="dashboard-section-header">
        <p class="badge">Metric definitions</p>
        <h2>What This Conversation Shows</h2>
        <p>These metrics are calculated from the saved transcript events, tool calls, and browser-side timing marks.</p>
      </div>
      <div class="definition-list">
        ${definition("Total Call Duration", formatMs(item.totalCallDurationMs), "Full elapsed time from call start to Stop.")}
        ${definition("Time To Successful Save", formatMs(item.timeToCompletionSaveMs), "Call start to successful save_confirmed_intake.")}
        ${definition("Firebase Save Duration", formatMs(item.saveDurationMs), "Network/API time for the backend Firebase save request.")}
        ${definition("Correction Rate", formatPercent(item.correctionRate), "Corrections divided by collected-field tool calls.")}
        ${definition("Corrected Fields", item.correctedFields.length ? item.correctedFields.join(", ") : "none", "Fields that were overwritten with a different value.")}
        ${definition("RAG Source Diversity", item.ragSourceDiversity, "Unique source pages returned by semantic RAG.")}
      </div>
    </section>
  `;
}

function renderQualityGroup(title, events, renderer) {
  return `
    <section class="quality-event-group">
      <h3>${escapeHtml(title)}</h3>
      <div class="stack">
        ${events.length ? events.map(renderer).join("") : `<p class="status">No ${escapeHtml(title.toLowerCase())} found.</p>`}
      </div>
    </section>
  `;
}

function renderCorrectionEvent(event) {
  return `
    <article class="quality-event-card">
      <div>
        <strong>${escapeHtml(event.field ?? "field corrected")}</strong>
        <p>${escapeHtml(formatOffset(event.timestampMs))}</p>
      </div>
      <p><b>Previous:</b> ${escapeHtml(event.previousValue ?? "unknown")}</p>
      <p><b>New:</b> ${escapeHtml(event.newValue ?? "unknown")}</p>
      <button class="button-link" data-audio-jump-ms="${eventPlayTimestampMs(event)}">Play from start</button>
    </article>
  `;
}

function renderToolFailureEvent(event) {
  return `
    <article class="quality-event-card tool-failure-card">
      <div>
        <strong>${escapeHtml(event.name ?? "tool failure")}</strong>
        <p>${escapeHtml(formatOffset(event.timestampMs))}</p>
      </div>
      <p><b>Error:</b> ${escapeHtml(event.error ?? "Tool returned an error.")}</p>
      ${event.durationMs ? `<p><b>Duration:</b> ${escapeHtml(formatMs(event.durationMs))}</p>` : ""}
      ${event.args ? `<pre class="tool-payload">${escapeHtml(JSON.stringify(event.args, null, 2))}</pre>` : ""}
      <button class="button-link" data-audio-jump-ms="${eventPlayTimestampMs(event)}">Play from start</button>
    </article>
  `;
}

function attachAudioJumpHandlers() {
  document.querySelectorAll("[data-audio-jump-ms]").forEach((button) => {
    button.addEventListener("click", () => {
      const audioEl = document.querySelector("#evalConversationAudio");
      if (!audioEl) return;
      audioEl.currentTime = Number(button.dataset.audioJumpMs ?? 0) / 1000;
      audioEl.play();
    });
  });
}

function renderConversationReview(conversation, audio) {
  const transcripts = conversation.transcripts ?? [];
  const toolCalls = conversation.toolCalls ?? [];
  const transcriptGroups = groupTranscriptWithToolCalls(transcripts, toolCalls);
  const fullTranscript = conversation.fullTranscript ?? buildFullTranscript(conversation, transcripts);
  const exchangeRowTags = latencyExchangeRowTags(conversation);

  reviewEl.innerHTML = `
    <div class="dashboard-section-header">
      <p class="badge">${escapeHtml(displayVoiceModel(conversation.voiceModel))}</p>
      <h2>Conversation Review</h2>
      <p>${escapeHtml(conversation.customerName ?? "Unknown customer")} · ${escapeHtml(conversation.mode ?? "unknown")} · ${escapeHtml(formatDate(conversation.startedAt))}</p>
    </div>

    <div class="eval-inline-audio">
      <div>
        <span class="eyebrow">Conversation audio</span>
        <strong>Click transcript rows to jump</strong>
      </div>
      <audio id="evalInlineConversationAudio" controls src="${escapeHtml(audio?.conversation ?? "")}"></audio>
    </div>

    <h3>Transcript & Tool Calls</h3>
    <div class="stack eval-inline-transcript">
      ${
        transcriptGroups.length
          ? transcriptGroups
              .map((group, transcriptIndex) =>
                renderTranscriptGroup(group, conversation, transcriptIndex, exchangeRowTags.get(transcriptIndex)),
              )
              .join("")
          : "<p>No transcript entries saved.</p>"
      }
    </div>

    <details class="full-transcript-details">
      <summary>Full Transcript</summary>
      <pre>${escapeHtml(fullTranscript)}</pre>
    </details>
  `;
}

function attachTranscriptAudioHandlers() {
  reviewEl.querySelectorAll("[data-audio-track]").forEach((row) => {
    row.addEventListener("click", () => {
      const audioEl = document.querySelector("#evalInlineConversationAudio");
      if (!audioEl) return;
      audioEl.currentTime = Number(row.dataset.timestampMs ?? 0) / 1000;
      audioEl.play();
    });
  });
}

function groupTranscriptWithToolCalls(transcripts, toolCalls) {
  return transcripts.map((entry, index) => {
    const startMs = Number(entry.timestampMs ?? 0);
    const nextMs = Number(transcripts[index + 1]?.timestampMs ?? Infinity);
    const calls = toolCalls.filter((call) => {
      const callMs = Number(call.timestampMs ?? 0);
      return callMs >= startMs && callMs < nextMs;
    });

    return {
      entry,
      calls,
    };
  });
}

function renderTranscriptGroup(group, conversation, transcriptIndex, exchangeTag) {
  const { entry, calls } = group;
  const turnAttr =
    exchangeTag != null && Number.isFinite(exchangeTag.latencyIx)
      ? ` data-latency-exchange="${exchangeTag.latencyIx}" data-latency-side="${exchangeTag.side}"`
      : "";
  return `
    <div class="transcript-group"${turnAttr}>
      <button class="transcript-row" data-audio-track="${escapeHtml(entry.audioTrack ?? "conversation")}" data-timestamp-ms="${escapeHtml(entry.timestampMs ?? 0)}">
        <span class="speaker-line">
          <strong>${escapeHtml(transcriptSpeaker(entry, conversation))}:</strong>
          ${escapeHtml(entry.text)}
        </span>
        <span class="timestamp">${escapeHtml(formatOffset(entry.timestampMs))}</span>
      </button>
      ${calls.length ? `<div class="inline-tool-calls">${calls.map(renderToolCall).join("")}</div>` : ""}
    </div>
  `;
}

function renderToolCall(call) {
  const details = toolCallDetails(call);
  return `
    <details class="inline-tool-call">
      <summary>
        <span class="tool-name">${escapeHtml(call.name ?? "tool_call")}</span>
        ${details.length ? details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join("") : ""}
      </summary>
      <div class="tool-call-expanded">
        <div>
          <h4>Input / Query</h4>
          ${renderToolPayload(call.args)}
        </div>
        <div>
          <h4>Output Returned To Lizzy</h4>
          ${renderToolPayload(call.output)}
        </div>
      </div>
    </details>
  `;
}

function renderToolPayload(payload) {
  if (!payload) return `<p class="status">Not available for this saved conversation.</p>`;
  if (Array.isArray(payload?.results)) {
    return `<div class="rag-results">${payload.results.map(renderRagResult).join("")}</div>`;
  }
  return `<pre class="tool-payload">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>`;
}

function renderRagResult(result, index) {
  return `
    <article class="rag-result">
      <strong>Result ${index + 1}: ${escapeHtml(result.title ?? "Untitled")}</strong>
      <span>${escapeHtml(result.heading ?? "")}</span>
      <span>score: ${escapeHtml(formatToolValue(result.score ?? ""))}</span>
      ${result.sourceUrl ? `<a href="${escapeHtml(result.sourceUrl)}" target="_blank" rel="noreferrer">source</a>` : ""}
      <p>${escapeHtml(result.snippet ?? "")}</p>
    </article>
  `;
}

function toolCallDetails(call) {
  const args = call.args ?? {};
  const details = [];
  if (args.field) details.push(`field: ${args.field}`);
  if (args.value) details.push(`value: ${formatToolValue(args.value)}`);
  if (!args.field && args.query) details.push(`query: ${args.query}`);
  if (!args.field && args.vin) details.push(`vin: ${args.vin}`);
  if (!details.length && Object.keys(args).length) {
    Object.entries(args).forEach(([key, value]) => details.push(`${key}: ${formatToolValue(value)}`));
  }
  return details;
}

function formatToolValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function buildFullTranscript(conversation, transcripts) {
  return transcripts.map((entry) => `${transcriptSpeaker(entry, conversation)}: ${entry.text}`).join("\n");
}

function transcriptSpeaker(entry, conversation) {
  const customerFirstName = String(conversation?.finalState?.firstName ?? conversation?.customerName ?? "")
    .trim()
    .split(/\s+/)[0];
  const rawRole = String(entry.sourceRole ?? entry.role ?? "").toLowerCase();
  if (rawRole === "agent" || rawRole === "assistant" || entry.role === "Lizzy") return "Lizzy";
  if (rawRole === "user" || rawRole === "customer" || entry.role === "Customer") return customerFirstName || "Customer";
  return entry.speaker ?? entry.role ?? "Speaker";
}

function definition(label, value, description) {
  return `
    <article class="definition-card">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
      <p>${escapeHtml(description)}</p>
    </article>
  `;
}
