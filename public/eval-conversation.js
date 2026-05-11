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
} from "./evalMetrics.js";

const titleEl = document.querySelector("#conversationTitle");
const descriptionEl = document.querySelector("#conversationDescription");
const summaryEl = document.querySelector("#conversationSummary");
const chartsEl = document.querySelector("#conversationCharts");
const detailsEl = document.querySelector("#conversationDetails");
const reviewEl = document.querySelector("#conversationReview");

await loadConversationEval();

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
  const responsePoints = item.responseLatencies.map((latency, index) => ({
    ...item,
    chartLabel: formatOffset(latency.userTimestampMs),
    startedAt: item.startedAt,
    avgFirstAudioLatencyMs: latency.firstAudioLatencyMs,
    avgFinalTranscriptLatencyMs: latency.finalTranscriptLatencyMs,
  }));
  const toolPoints = item.ragCalls.length
    ? item.ragCalls.map((call, index) => ({
        ...item,
        chartLabel: call.timestampMs !== undefined ? formatOffset(call.timestampMs) : `RAG${index + 1}`,
        avgToolDurationMs: call.durationMs,
        ragLatencyMs: call.output?.ragLatencyMs,
      }))
    : [item];
  const toolUsagePoints = Object.entries(item.toolUsageByName).map(([name, count]) => ({
    ...item,
    chartLabel: name,
    count,
  }));
  const ragScorePoints = item.ragCallScoreStats.map((stat) => ({
    ...item,
    chartLabel: stat.timestampMs !== undefined ? formatOffset(stat.timestampMs) : stat.label,
    query: stat.query,
  }));
  const maxRagResultCount = Math.max(0, ...item.ragCallScoreStats.map((stat) => stat.scores.length));
  const ragDistributionSeries = Array.from({ length: maxRagResultCount }, (_, index) => ({
    label: `Result ${index + 1} score`,
    values: item.ragCallScoreStats.map((stat) => stat.scores[index]),
    color: ["#5a8aaa", "#87afc7", "#1e2030", "#778899", "#b0cfe0"][index % 5],
  }));

  const responseLatencyChartInner = responsePoints.length
    ? lineChart(
        [
          {
            label: "Response start",
            values: responsePoints.map((point) => point.avgFirstAudioLatencyMs),
            color: "#5a8aaa",
          },
          {
            label: "Response complete",
            values: responsePoints.map((point) => point.avgFinalTranscriptLatencyMs),
            color: "#111827",
          },
        ],
        responsePoints,
        formatMs,
        {
          xLabel: "User turn timestamp in conversation audio",
          yLabel: "Latency in milliseconds/seconds",
        },
      )
    : `<p class="status">No response latency samples captured for this conversation.</p>`;

  const toolRuntimeChartInner = lineChart(
    [
      {
        label: "Tool runtime",
        values: toolPoints.map((point) => point.avgToolDurationMs),
        color: "#87afc7",
      },
      {
        label: "RAG runtime",
        values: toolPoints.map((point) => point.ragLatencyMs),
        color: "#1e2030",
      },
    ],
    toolPoints,
    formatMs,
    {
      xLabel: "RAG tool-call timestamp in conversation audio",
      yLabel: "Runtime in milliseconds/seconds",
    },
  );

  chartsEl.innerHTML = [
    `
    <section class="card chart-card chart-card-latency-combo">
      <div>
        <h2>Latency &amp; runtime</h2>
        <p>
          Time from user turns to Lizzy responding, plus tool and RAG retrieval duration for each knowledge search tool call—all in one wide pane for easier scanning.
        </p>
      </div>
      <div class="latency-combo-charts">
        <div class="latency-combo-block">
          <h3>Turn-by-turn response latency</h3>
          ${responseLatencyChartInner}
        </div>
        <div class="latency-combo-block">
          <h3>Tool &amp; RAG runtime</h3>
          ${toolRuntimeChartInner}
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
              xLabel: "Tool name",
              yLabel: "Number of calls",
            },
          )
        : `<p class="status">No tool calls captured for this conversation.</p>`,
    ),
    chartCard(
      "Corrections In This Conversation",
      "Updates that replaced an already captured intake field with a different value.",
      groupedBarChart(
        [
          {
            label: "Field corrections",
            values: [item.correctionCount],
            color: "#5a8aaa",
          },
        ],
        [item],
        String,
        {
          xLabel: "This conversation",
          yLabel: "Correction count",
        },
      ),
    ),
    chartCard(
      "RAG Average Result Score Per Tool Call",
      "For each RAG tool call, shows the average cosine score across returned results.",
      item.ragCallScoreStats.length
        ? lineChart(
            [
              {
                label: "Average result score",
                values: item.ragCallScoreStats.map((stat) => stat.averageScore),
                color: "#5a8aaa",
              },
            ],
            ragScorePoints,
            formatScore,
            {
              xLabel: "RAG tool-call timestamp in conversation audio",
              yLabel: "Cosine similarity score",
            },
          )
        : `<p class="status">No RAG tool calls captured for this conversation.</p>`,
    ),
    chartCard(
      "RAG Match Score Distribution Per Query",
      "Each line is one returned result rank. The spread between lines shows whether a query had a clear best match or flat scores.",
      ragDistributionSeries.length
        ? lineChart(ragDistributionSeries, ragScorePoints, formatScore, {
            xLabel: "RAG query timestamp in conversation audio",
            yLabel: "Cosine match score for each returned result",
          })
        : `<p class="status">No RAG result scores captured for this conversation.</p>`,
    ),
  ].join("");
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
      ${transcriptGroups.length ? transcriptGroups.map((group) => renderTranscriptGroup(group, conversation)).join("") : "<p>No transcript entries saved.</p>"}
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

function renderTranscriptGroup(group, conversation) {
  const { entry, calls } = group;
  return `
    <div class="transcript-group">
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
