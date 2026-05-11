export const metricHelp = {
  totalConversations: "Saved calls included in this dashboard.",
  averageResponseStart: "Average time from user transcript completion to Lizzy's first audio starting.",
  averageResponseComplete: "Average time from user transcript completion to Lizzy's response transcript finishing.",
  averageToolDuration: "Average time from receiving a tool call to returning its output to Lizzy.",
  averageRagLatency: "Average time spent retrieving semantic RAG results.",
  corrections: "Times a captured field was changed after already having a different value.",
  silentFailures: "Tool calls that returned an error or failed validation.",
  ragTopScore: "Best cosine similarity score among top RAG results. Higher is better.",
  lowConfidenceRag: "RAG calls where the top result score was below 0.35.",
};

/**
 * Older saves omit voiceModel; OpenAI realtime calls default to GPT Realtime 2.
 */
export function coerceVoiceModel(voiceModel) {
  if (!voiceModel || typeof voiceModel !== "object") {
    return { provider: "openai", model: "gpt-realtime-2" };
  }
  const providerRaw = voiceModel.provider ?? "openai";
  const provider = String(providerRaw).toLowerCase();
  const rawModel = voiceModel.model != null ? String(voiceModel.model).trim() : "";
  if (provider === "openai" && (!rawModel || rawModel === "unknown")) {
    return { ...voiceModel, provider: providerRaw, model: "gpt-realtime-2" };
  }
  return { ...voiceModel, provider: providerRaw, model: rawModel || voiceModel.model };
}

export function buildConversationEval(conversation) {
  const toolCalls = conversation.toolCalls ?? [];
  const transcripts = conversation.transcripts ?? [];
  const evals = conversation.evals ?? {};
  const responseLatencies = evals.responseLatencies ?? [];
  const ragCalls = toolCalls.filter((call) => call.name === "search_auto_insurance_knowledge");
  const ragResults = ragCalls.flatMap((call) => call.output?.results ?? []);
  const ragTopScores = ragCalls.map((call) => Number(call.output?.results?.[0]?.score ?? 0)).filter((score) => score > 0);
  const ragCallScoreStats = ragCalls.map((call, index) => {
    const scores = (call.output?.results ?? []).map((result) => Number(result.score ?? 0)).filter((score) => score > 0);
    return {
      label: `RAG${index + 1}`,
      timestampMs: call.timestampMs,
      query: call.args?.query,
      scores,
      topScore: max(scores),
      averageScore: average(scores),
      resultCount: scores.length,
    };
  });
  const ragLatencies = ragCalls.map((call) => Number(call.output?.ragLatencyMs ?? call.durationMs ?? 0)).filter(Boolean);
  const toolDurations = toolCalls.map((call) => Number(call.durationMs ?? 0)).filter(Boolean);
  const saveCall = toolCalls.find((call) => call.name === "save_confirmed_intake");
  const collectedFieldCalls = toolCalls.filter((call) => call.name === "update_collected_field");
  const uniqueRagSources = new Set(ragResults.map((result) => result.sourceUrl || result.title).filter(Boolean));
  const traceableRagResults = ragResults.filter((result) => result.title && result.sourceUrl && result.snippet).length;
  const corrections = evals.corrections ?? [];
  const toolFailures = toolCalls
    .filter((call) => call.output?.ok === false)
    .map((call) => ({
      name: call.name,
      error: call.output?.error ?? "Tool returned an error.",
      args: call.args,
      timestampMs: call.timestampMs,
      completedAtMs: call.completedAtMs,
      userUtteranceStartMs: call.userUtteranceStartMs,
      durationMs: call.durationMs,
      playTimestampMs: call.timestampMs,
    }));

  return {
    id: conversation.id,
    displayId: shortId(conversation.id),
    customerName: conversation.customerName ?? "Unknown customer",
    mode: conversation.mode ?? "unknown",
    voiceModel: coerceVoiceModel(conversation.voiceModel),
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    totalCallDurationMs: Number(evals.totalCallDurationMs ?? dateDiffMs(conversation.startedAt, conversation.endedAt)),
    timeToCompletionSaveMs: Number(evals.timeToCompletionSaveMs ?? saveCall?.completedAtMs ?? 0),
    responseLatencies,
    responseCount: responseLatencies.length,
    avgFirstAudioLatencyMs: averageWithZero(responseLatencies.map((item) => item.firstAudioLatencyMs).filter(Number.isFinite)),
    avgFinalTranscriptLatencyMs: average(responseLatencies.map((item) => item.finalTranscriptLatencyMs).filter(Number.isFinite)),
    avgToolDurationMs: average(toolDurations),
    maxToolDurationMs: max(toolDurations),
    saveDurationMs: Number(saveCall?.output?.saveDurationMs ?? saveCall?.durationMs ?? 0),
    correctionCount: Number(corrections.length),
    corrections,
    toolFailures,
    correctedFields: evals.fieldsCorrected ?? [],
    correctionRate: collectedFieldCalls.length ? corrections.length / collectedFieldCalls.length : 0,
    reAskCount: Number(evals.reAskCount ?? 0),
    toolOverwriteCount: Number(evals.toolOverwriteCount ?? 0),
    interruptionCount: Number(evals.interruptionCount ?? 0),
    silentFailureCount: Number(evals.silentFailureCount ?? toolFailures.length),
    ragCallCount: ragCalls.length,
    ragCalls,
    ragCallScoreStats,
    ragTopScore: max(ragTopScores),
    ragAverageTopScore: average(ragTopScores),
    ragAverageResultScore: average(ragCallScoreStats.map((item) => item.averageScore).filter(Number.isFinite)),
    ragLowConfidenceCount: ragTopScores.filter((score) => score < 0.35).length,
    ragDuplicateResultCount: countDuplicateRagResults(ragResults),
    ragLatencyMs: average(ragLatencies),
    ragSourceDiversity: uniqueRagSources.size,
    ragCitationTraceability: ragResults.length > 0 ? traceableRagResults / ragResults.length : undefined,
    transcriptCount: transcripts.length,
    toolCallCount: toolCalls.length,
    toolUsageByName: countBy(toolCalls.map((call) => call.name ?? "unknown")),
  };
}

export function buildAggregate(evals) {
  return {
    conversations: evals.length,
    avgFirstAudioLatencyMs: averageWithZero(evals.map((item) => item.avgFirstAudioLatencyMs).filter(Number.isFinite)),
    avgFinalTranscriptLatencyMs: average(evals.map((item) => item.avgFinalTranscriptLatencyMs).filter(Boolean)),
    avgToolDurationMs: average(evals.map((item) => item.avgToolDurationMs).filter(Boolean)),
    avgRagLatencyMs: average(evals.map((item) => item.ragLatencyMs).filter(Boolean)),
    corrections: sum(evals.map((item) => item.correctionCount)),
    silentFailures: sum(evals.map((item) => item.silentFailureCount)),
    ragLowConfidence: sum(evals.map((item) => item.ragLowConfidenceCount)),
    avgRagTopScore: average(evals.map((item) => item.ragTopScore).filter(Boolean)),
    avgRagResultScore: average(evals.map((item) => item.ragAverageResultScore).filter(Boolean)),
  };
}

/** Flatten tool failures (`output.ok === false`) across conversations, newest conversations first. */
export function collectAllToolFailures(conversationEvals) {
  const rows = [];
  for (const conv of conversationEvals) {
    for (const failure of conv.toolFailures ?? []) {
      rows.push({
        conversationId: conv.id,
        displayId: conv.displayId,
        listOrdinal: conv.listOrdinal,
        customerName: conv.customerName,
        startedAt: conv.startedAt,
        voiceModel: conv.voiceModel,
        failure,
      });
    }
  }
  rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return rows;
}

export function summarizeToolArgs(args) {
  if (!args || typeof args !== "object") return "";
  if (args.field !== undefined && args.field !== "") return `field: ${truncateForDisplay(String(args.field), 72)}`;
  if (typeof args.query === "string" && args.query.trim()) return `query: ${truncateForDisplay(args.query.trim(), 96)}`;
  if (args.vin !== undefined && args.vin !== "") return `vin: ${truncateForDisplay(String(args.vin), 24)}`;
  const keys = Object.keys(args).filter(Boolean);
  if (!keys.length) return "";
  return keys
    .slice(0, 2)
    .map((key) => `${key}: ${truncateForDisplay(JSON.stringify(args[key]), 56)}`)
    .join(" · ");
}

function truncateForDisplay(text, max) {
  const s = text.length <= max ? text : `${text.slice(0, max - 1)}…`;
  return s.replaceAll("\n", " ");
}

export async function loadConversationEvals() {
  const response = await fetch("/api/conversations");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error ?? "Failed to load conversations.");
  }

  const conversations = await Promise.all(
    data.conversations.map(async (summary) => {
      const detailResponse = await fetch(`/api/conversations/${summary.id}`);
      const detail = await detailResponse.json();
      return detailResponse.ok ? detail.conversation : undefined;
    }),
  );

  return conversations.filter(Boolean).map(buildConversationEval);
}

export function metricCard(label, value, description = "") {
  return `
    <article class="metric-card metric-card-rich">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value ?? "n/a")}</strong>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    </article>
  `;
}

export function chartCard(title, description, chart) {
  return `
    <section class="card chart-card">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p>${escapeHtml(description)}</p>
      </div>
      ${chart}
    </section>
  `;
}

export function lineChart(series, evals, formatter, options = {}) {
  const width = 960;
  const height = 380;
  const plotLeft = 72;
  const plotRightMargin = 28;
  const plotTop = 22;
  const plotBottom = height - 32;
  const plotRight = width - plotRightMargin;
  const plotWidth = plotRight - plotLeft;
  const plotHeight = plotBottom - plotTop;

  const allValues = series.flatMap((item) => item.values).map((value) => Number(value)).filter(Number.isFinite);
  const rawMax = Math.max(0, ...allValues, 0);
  const { yMax, ticks } = buildLinearYAxisTicks(rawMax <= 0 ? 1 : rawMax, 4);

  const denom = Math.max(evals.length - 1, 1);
  const lines = series
    .map((item) => {
      const seriesId = slugify(item.label);
      const points = item.values
        .map((value, index) => {
          const x = plotLeft + (index / denom) * plotWidth;
          const yVal = Number(value);
          const norm = Number.isFinite(yVal) ? Math.min(Math.max(yVal / yMax, 0), 1) : 0;
          const y = plotBottom - norm * plotHeight;
          return `${x},${y}`;
        })
        .join(" ");
      const dots = item.values
        .map((value, index) => {
          const x = plotLeft + (index / denom) * plotWidth;
          const yVal = Number(value);
          const norm = Number.isFinite(yVal) ? Math.min(Math.max(yVal / yMax, 0), 1) : 0;
          const y = plotBottom - norm * plotHeight;
          const label = shortConversationLabel(evals[index] ?? {});
          return `<circle class="chart-point" cx="${x}" cy="${y}" r="6" tabindex="0" data-conversation-id="${escapeHtml(evals[index]?.id ?? "")}" data-series="${escapeHtml(seriesId)}" data-label="${escapeHtml(item.label)}" data-point="${escapeHtml(label)}" data-value="${escapeHtml(formatter(value))}"></circle>`;
        })
        .join("");
      return `<g class="chart-series" data-series="${escapeHtml(seriesId)}" style="color:${item.color}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />${dots}</g>`;
    })
    .join("");

  const horizontalGridAndYTicks = renderHorizontalGridAndYTicks({
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax,
    ticks,
    formatter,
  });

  return `
    ${chartLegend(series)}
    <div class="chart-scroll chart-line-scroll">
      <svg class="eval-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
        ${baselineX(plotLeft, plotRight, plotBottom)}
        ${horizontalGridAndYTicks}
        ${lines}
      </svg>
    </div>
    ${chartXAxis(evals)}
    ${chartAxisLabels(options)}
  `;
}

export function groupedBarChart(series, evals, formatter, options = {}) {
  const barStackPx = 180;
  const allValues = series.flatMap((item) => item.values).map((value) => Number(value)).filter(Number.isFinite);
  const rawMax = Math.max(0, ...allValues, 0);
  const { yMax, ticks } = buildLinearYAxisTicks(rawMax <= 0 ? 1 : rawMax, 4);
  const tickLabelsDescending = [...ticks].reverse();

  const barMarkup = `
    <div class="bar-chart" style="--bar-count:${Math.max(evals.length, 1)}">
      ${evals
        .map(
          (item, index) => `
            <div class="bar-group">
              <div class="bar-stack">
                ${series
                  .map((entry) => {
                    const value = Number(entry.values[index] ?? 0);
                    const fraction = value > 0 ? Math.min(value / yMax, 1) : 0;
                    const pxHeight = fraction > 0 ? Math.max(4, fraction * barStackPx) : 0;
                    return `
                      <span class="bar" data-series="${escapeHtml(slugify(entry.label))}" style="height:${pxHeight}px; --bar-height:${fraction * 100}%; --bar-color:${entry.color}">
                        <strong>${escapeHtml(formatter(value))}</strong>
                      </span>
                    `;
                  })
                  .join("")}
              </div>
              <span class="bar-label">${escapeHtml(shortConversationLabel(item))}</span>
            </div>
          `,
        )
        .join("")}
    </div>
  `;

  return `
    ${chartLegend(series)}
    <div class="chart-scroll">
      <div class="bar-chart-shell">
        <div class="bar-y-scale" aria-hidden="true">
          ${tickLabelsDescending.map((t) => `<span>${escapeHtml(axisTickFormatter(formatter, t))}</span>`).join("")}
        </div>
        <div class="bar-chart-canvas">${barMarkup}</div>
      </div>
    </div>
    ${chartAxisLabels(options)}
  `;
}

function baselineX(x1, x2, y) {
  return `<line class="chart-axis-base" x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" />`;
}

function renderHorizontalGridAndYTicks({ plotLeft, plotRight, plotTop, plotBottom, yMax, ticks, formatter }) {
  return ticks
    .map((tick) => {
      const y = plotBottom - (tick / yMax) * (plotBottom - plotTop);
      return `
      <line class="chart-grid-h" x1="${plotLeft}" y1="${y}" x2="${plotRight}" y2="${y}" />
      <text class="chart-y-tick" x="${plotLeft - 8}" y="${y + 4}" dominant-baseline="middle" text-anchor="end">${escapeHtml(axisTickFormatter(formatter, tick))}</text>
    `;
    })
    .join("");
}

function buildLinearYAxisTicks(rawMax, segments = 4) {
  const yMax = rawMax <= 0 ? 1 : niceUpperBound(rawMax * 1.06);
  const ticks = [];
  for (let i = 0; i <= segments; i++) ticks.push((yMax * i) / segments);
  return { yMax, ticks };
}

function niceUpperBound(value) {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  const niceFrac = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFrac * Math.pow(10, exponent);
}

function axisTickFormatter(formatter, value) {
  if (!Number.isFinite(value)) return "";
  if (formatter === formatScore && value === 0) return "0.000";
  const formatted = formatter(value);
  return formatted !== "n/a" ? formatted : formatter === formatScore ? value.toFixed(3) : String(value);
}

function chartLegend(series) {
  return `
    <div class="chart-legend">
      ${series
        .map(
          (item) =>
            `<button type="button" data-chart-series-toggle="${escapeHtml(slugify(item.label))}"><i style="background:${item.color}"></i>${escapeHtml(item.label)}</button>`,
        )
        .join("")}
    </div>
  `;
}

export function attachChartInteractions(root = document) {
  root.querySelectorAll("[data-chart-series-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const chartCard = button.closest(".chart-card");
      const seriesId = button.dataset.chartSeriesToggle;
      const isHidden = button.classList.toggle("muted");
      chartCard?.querySelectorAll("[data-series]").forEach((element) => {
        if (element.dataset.series === seriesId) {
          element.classList.toggle("hidden-series", isHidden);
        }
      });
    });
  });

  const tooltip = getChartTooltip();
  root.querySelectorAll(".chart-point").forEach((point) => {
    point.addEventListener("pointerenter", (event) => showChartTooltip(event, tooltip));
    point.addEventListener("pointermove", (event) => positionChartTooltip(event, tooltip));
    point.addEventListener("pointerleave", () => hideChartTooltip(tooltip));
    point.addEventListener("focus", (event) => showChartTooltip(event, tooltip));
    point.addEventListener("blur", () => hideChartTooltip(tooltip));
    point.addEventListener("click", (event) => {
      showChartTooltip(event, tooltip);
      tooltip.classList.toggle("pinned");
      const conversationId = point.dataset.conversationId;
      const label = point.dataset.label ?? "";
      if (conversationId && /correction|failure/i.test(label)) {
        window.location.href = `/evals/conversation?id=${encodeURIComponent(conversationId)}#quality-events`;
      }
    });
  });
}

function getChartTooltip() {
  let tooltip = document.querySelector("#evalChartTooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "evalChartTooltip";
    tooltip.className = "chart-tooltip";
    document.body.append(tooltip);
  }
  return tooltip;
}

function showChartTooltip(event, tooltip) {
  const target = event.currentTarget;
  tooltip.innerHTML = `
    <strong>${escapeHtml(target.dataset.label ?? "")}</strong>
    <span>${escapeHtml(target.dataset.point ?? "")}</span>
    <b>${escapeHtml(target.dataset.value ?? "n/a")}</b>
  `;
  tooltip.classList.add("visible");
  positionChartTooltip(event, tooltip);
}

function positionChartTooltip(event, tooltip) {
  const pointerEvent = "clientX" in event ? event : undefined;
  const targetRect = event.currentTarget.getBoundingClientRect();
  const x = pointerEvent?.clientX ?? targetRect.left + targetRect.width / 2;
  const y = pointerEvent?.clientY ?? targetRect.top;
  tooltip.style.left = `${Math.min(window.innerWidth - 220, Math.max(12, x + 14))}px`;
  tooltip.style.top = `${Math.max(12, y - 18)}px`;
}

function hideChartTooltip(tooltip) {
  if (tooltip.classList.contains("pinned")) return;
  tooltip.classList.remove("visible");
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function chartXAxis(evals) {
  return `
    <div class="chart-x-axis">
      ${evals.map((item) => `<span>${escapeHtml(shortConversationLabel(item))}</span>`).join("")}
    </div>
  `;
}

function chartAxisLabels(options) {
  if (!options.xLabel && !options.yLabel) return "";
  return `
    <div class="chart-axis-labels">
      <span>Y-axis: ${escapeHtml(options.yLabel ?? "value")}</span>
      <span>X-axis: ${escapeHtml(options.xLabel ?? "items")}</span>
    </div>
  `;
}

function countDuplicateRagResults(results) {
  const seen = new Set();
  let duplicates = 0;
  results.forEach((result) => {
    const key = `${result.sourceUrl ?? result.title ?? ""}:${result.heading ?? ""}`;
    if (seen.has(key)) {
      duplicates += 1;
      return;
    }
    seen.add(key);
  });
  return duplicates;
}

export function eventPlayTimestampMs(event) {
  const endMsRaw = Number(event?.completedAtMs ?? event?.timestampMs ?? 0);
  const utterStartMs = Number(event?.userUtteranceStartMs);
  const endMs = Number.isFinite(endMsRaw) ? endMsRaw : 0;

  if (
    Number.isFinite(utterStartMs) &&
    utterStartMs >= 0 &&
    (!endMs || utterStartMs <= endMs + 500)
  ) {
    return Math.max(0, utterStartMs);
  }

  const playMsRaw = Number(event?.playTimestampMs);
  if (Number.isFinite(playMsRaw) && playMsRaw >= 0) {
    return Math.max(0, playMsRaw);
  }

  let cue =
    typeof event?.newValue === "string"
      ? `${event?.previousValue ?? ""} ${event.newValue}`.trim()
      : "";
  if (!cue && event?.args?.query !== undefined && event.args.query !== "") {
    cue = String(event.args.query);
  } else if (!cue && event?.args) {
    cue = JSON.stringify(event.args);
  }

  const estimated = estimateUtteranceStartMs(endMs || Number(event?.timestampMs) || 0, cue);
  if (Number.isFinite(estimated) && estimated >= 0) {
    return estimated;
  }

  return Math.max(0, Number(event?.timestampMs ?? 0) - 15000);
}

export function estimateUtteranceStartMs(endTimestampMs, text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const estimatedDurationMs = Math.min(9000, Math.max(1400, words * 400));
  return Math.max(0, Math.round(Number(endTimestampMs ?? 0) - estimatedDurationMs));
}

export function average(values) {
  const cleanValues = values.filter((value) => Number.isFinite(value) && value > 0);
  if (cleanValues.length === 0) return undefined;
  return sum(cleanValues) / cleanValues.length;
}

function averageWithZero(values) {
  const cleanValues = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (cleanValues.length === 0) return undefined;
  return sum(cleanValues) / cleanValues.length;
}

function max(values) {
  const cleanValues = values.filter((value) => Number.isFinite(value));
  return cleanValues.length ? Math.max(...cleanValues) : undefined;
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value ?? 0), 0);
}

function countBy(values) {
  return values.reduce((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function dateDiffMs(start, end) {
  if (!start || !end) return 0;
  return Math.max(0, new Date(end).getTime() - new Date(start).getTime());
}

export function formatMs(value) {
  if (!Number.isFinite(value) || value < 0) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(value * 100)}%`;
}

export function formatScore(value) {
  if (!Number.isFinite(value) || value <= 0) return "n/a";
  return value.toFixed(3);
}

export function formatDate(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString();
}

export function displayProviderName(provider) {
  const p = String(provider ?? "openai").toLowerCase();
  if (p === "openai") return "OpenAI";
  if (p === "grok") return "Grok";
  if (p === "gemini") return "Gemini";
  return String(provider ?? "unknown");
}

export function displayModelName(modelSlug) {
  if (modelSlug == null || modelSlug === "") return "unknown";
  const s = String(modelSlug);
  if (s === "gpt-realtime-2") return "GPT Realtime 2";
  return s;
}

export function displayVoiceModel(voiceModel) {
  const vm = coerceVoiceModel(voiceModel);
  return `${displayProviderName(vm.provider)} · ${displayModelName(vm.model)}`;
}

export function formatOffset(ms) {
  const totalSeconds = Math.floor((ms ?? 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function shortConversationLabel(item) {
  if (item?.listOrdinal != null && Number.isFinite(item.listOrdinal)) return String(item.listOrdinal);
  return item.chartLabel ?? item.displayId ?? shortId(item.id) ?? "Call";
}

function shortId(id) {
  return id ? `C-${String(id).slice(0, 6)}` : undefined;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
