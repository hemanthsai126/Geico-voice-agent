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
  const ragCalls = toolCalls.filter((call) => {
    const n = call.name ?? "";
    return n === "search_auto_insurance_knowledge" || n.startsWith("search_auto_insurance_knowledge");
  });
  const ragResults = ragCalls.flatMap((call) => call.output?.results ?? []);
  const ragTopScores = ragCalls.map((call) => Number(call.output?.results?.[0]?.score ?? 0)).filter((score) => score > 0);
  const ragCallScoreStats = ragCalls.map((call, index) => {
    const rawResults = Array.isArray(call.output?.results) ? call.output.results : [];
    const documents = rawResults
      .map((result, ri) => {
        const sc = Number(result.score ?? 0);
        if (!Number.isFinite(sc) || sc <= 0) return null;
        return {
          rank: ri + 1,
          score: sc,
          docLabel: shortenRagDocLabel(ragDocumentGroupKey(result), 72),
        };
      })
      .filter(Boolean);
    const scores = documents.map((d) => d.score);
    return {
      label: `RAG${index + 1}`,
      timestampMs: call.timestampMs,
      query: call.args?.query,
      documents,
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
    transcripts,
    toolCallCount: toolCalls.length,
    toolUsageByName: countBy(toolCalls.map((call) => call.name ?? "unknown")),
  };
}

/**
 * Normalize a stable grouping key for a RAG chunk (prefers canonical URL pathname).
 */
export function ragDocumentGroupKey(result) {
  const url = typeof result.sourceUrl === "string" ? result.sourceUrl.trim() : "";
  if (url) {
    try {
      const pathname = new URL(url).pathname.replace(/\/+$/, "") || "/";
      return pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }
  const title = typeof result.title === "string" ? result.title.trim() : "";
  return title ? title.toLowerCase() : "(unknown)";
}

export function shortenRagDocLabel(groupKey, maxLen = 64) {
  const s = String(groupKey ?? "");
  if (!s.length) return "(unknown)";
  return s.length <= maxLen ? s : `${s.slice(0, maxLen - 1)}…`;
}

function sampleVarianceScores(scores) {
  const n = scores.length;
  if (n < 2) return 0;
  const mean = scores.reduce((total, score) => total + score, 0) / n;
  const sumSq = scores.reduce((total, score) => total + (score - mean) ** 2, 0);
  return sumSq / (n - 1);
}

function populationVariance(values) {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((total, score) => total + score, 0) / n;
  const sumSq = values.reduce((total, score) => total + (score - mean) ** 2, 0);
  return sumSq / n;
}

/**
 * Histogram over numeric samples with `[lo, hi)` bins (final bin closed on right).
 */
export function buildHistogramBins(values, binCount = 18) {
  const scores = values.filter((v) => Number.isFinite(v));
  scores.sort((a, b) => a - b);
  if (!scores.length) return { bins: [], min: 0, max: 0 };
  let min = scores[0];
  let max = scores[scores.length - 1];
  if (min === max) {
    max = min + 1e-6;
  }
  const bins = [];
  const width = (max - min) / binCount || 1e-6;
  for (let i = 0; i < binCount; i += 1) {
    const lo = min + i * width;
    const hi = i === binCount - 1 ? max + 1e-9 : min + (i + 1) * width;
    bins.push({ lo, hi, count: 0 });
  }
  for (const s of scores) {
    let idx = Math.floor((s - min) / width);
    if (idx < 0) idx = 0;
    if (idx >= binCount) idx = binCount - 1;
    bins[idx].count += 1;
  }
  return { bins, min, max };
}

/** Stats from saved `search_auto_insurance_knowledge` payloads across conversations. */
export function analyzeRagFromConversationEvals(conversationEvals) {
  const perCall = [];
  const docHits = new Map();
  const docTopHits = new Map();
  const docScoreSum = new Map();

  /** @type {number[]} */
  let allScores = [];

  /** @type {number[]} */
  const perCallRanges = [];
  /** @type {number[]} */
  const perCallStds = [];
  /** @type {number[]} */
  const perCallCoeffVar = [];

  let failedCalls = 0;
  let totalInvocationCount = 0;

  function bump(key, hitsMap, topsMap, sumsMap, hitsDelta, topsDelta, scoreSumDelta) {
    hitsMap.set(key, (hitsMap.get(key) ?? 0) + hitsDelta);
    if (topsDelta) topsMap.set(key, (topsMap.get(key) ?? 0) + topsDelta);
    sumsMap.set(key, (sumsMap.get(key) ?? 0) + scoreSumDelta);
  }

  for (const conv of conversationEvals) {
    for (const call of conv.ragCalls ?? []) {
      totalInvocationCount += 1;
      const rawResults = Array.isArray(call.output?.results) ? call.output.results : [];
      if (call.output?.ok !== true) {
        failedCalls += 1;
        continue;
      }

      /** @type {number[]} */
      const scores = rawResults.map((r) => Number(r.score)).filter((s) => Number.isFinite(s) && s > 0);
      const query = typeof call.args?.query === "string" ? call.args.query.trim() : "";

      rawResults.forEach((result, idx) => {
        const gk = ragDocumentGroupKey(result);
        const sc = Number(result.score);
        const valid = Number.isFinite(sc) && sc > 0;
        bump(gk, docHits, docTopHits, docScoreSum, 1, idx === 0 && valid ? 1 : 0, valid ? sc : 0);
      });

      allScores = allScores.concat(scores);

      if (scores.length === 0) {
        continue;
      }

      const sorted = [...scores].sort((a, b) => a - b);
      const minS = sorted[0];
      const maxS = sorted[sorted.length - 1];
      const range = maxS - minS;
      const meanScore = scores.reduce((total, score) => total + score, 0) / scores.length;
      const varSample = scores.length >= 2 ? sampleVarianceScores(scores) : 0;
      const std = Math.sqrt(varSample);
      perCallRanges.push(range);
      perCallStds.push(std);
      if (Number.isFinite(meanScore) && meanScore > 0) {
        perCallCoeffVar.push(std / meanScore);
      }

      const topDoc = rawResults[0];
      const topLabel = topDoc ? shortenRagDocLabel(ragDocumentGroupKey(topDoc), 96) : "—";

      perCall.push({
        conversationId: conv.id,
        listOrdinal: conv.listOrdinal,
        customerName: conv.customerName ?? "Unknown",
        startedAt: conv.startedAt,
        voiceModel: conv.voiceModel,
        query,
        ragLatencyMs: Number(call.output?.ragLatencyMs ?? call.durationMs ?? 0),
        resultCount: scores.length,
        minScore: minS,
        maxScore: maxS,
        rangeScore: range,
        meanScore,
        varianceScore: varSample,
        stdScore: std,
        coefficientOfVariation: meanScore > 0 ? std / meanScore : undefined,
        topSourceLabel: topLabel,
      });
    }
  }

  const totalHits = [...docHits.values()].reduce((a, n) => a + n, 0);
  const totalTop = [...docTopHits.values()].reduce((a, n) => a + n, 0);

  const docStats = [...docHits.entries()].map(([groupKey, hits]) => {
    const tops = docTopHits.get(groupKey) ?? 0;
    const sumScore = docScoreSum.get(groupKey) ?? 0;
    const avgScore = hits > 0 ? sumScore / hits : 0;
    return {
      groupKey,
      displayLabel: shortenRagDocLabel(groupKey, 72),
      hits,
      topHits: tops,
      shareOfHits: totalHits ? hits / totalHits : 0,
      shareOfTopHits: totalTop ? tops / totalTop : 0,
      avgScore,
    };
  });

  docStats.sort((a, b) => b.hits - a.hits);

  const histogram = buildHistogramBins(allScores, 18);

  const globalMean = allScores.length ? allScores.reduce((a, s) => a + s, 0) / allScores.length : 0;
  const globalVariance = populationVariance(allScores);

  const avgRange = perCallRanges.length ? perCallRanges.reduce((a, s) => a + s, 0) / perCallRanges.length : 0;
  const avgStd = perCallStds.length ? perCallStds.reduce((a, s) => a + s, 0) / perCallStds.length : 0;
  const avgCv = perCallCoeffVar.length ? perCallCoeffVar.reduce((a, s) => a + s, 0) / perCallCoeffVar.length : 0;
  const flatQueryThreshold = 0.02;
  const flatQueriesPct = perCallRanges.length
    ? perCallRanges.filter((r) => r < flatQueryThreshold).length / perCallRanges.length
    : 0;

  perCall.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

  return {
    totalRagInvocations: totalInvocationCount,
    successfulCallRows: perCall.length,
    failedRagCalls: failedCalls,
    totalResultPositions: totalHits,
    perCallSummaries: perCall,
    documentStats: docStats,
    histogram,
    globalMeanScore: globalMean,
    globalStdScore: Math.sqrt(globalVariance),
    aggregates: {
      avgScoreRangeWithinQuery: avgRange,
      avgWithinQueryStd: avgStd,
      avgCoefficientOfVariation: avgCv,
      fractionQueriesVeryFlatRange: flatQueriesPct,
      flatRangeThreshold: flatQueryThreshold,
    },
    concentration: concentrationFromShares(docStats.map((d) => d.shareOfHits)),
  };
}

function concentrationFromShares(shares) {
  const clean = shares.filter((s) => Number.isFinite(s) && s > 0);
  if (!clean.length) return { hHI: undefined, effectiveDocs: undefined };
  const h = clean.reduce((sum, p) => sum + p ** 2, 0);
  const effectiveDocs = h > 0 ? 1 / h : undefined;
  return { hHI: h, effectiveDocs };
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

/**
 * Compact 0→max bar for a single nonnegative integer (e.g. correction count in transcript evidence).
 */
export function simpleIntegerBar(count, options = {}) {
  const raw = Number(count);
  const n = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  const minScale = Number(options.minScale) > 0 ? Number(options.minScale) : 5;
  let maxTick = Math.max(minScale, n + 3, Math.ceil(Math.max(n, 1) * 1.2));
  maxTick = Math.max(maxTick, n);
  const pct = maxTick <= 0 ? 0 : Math.min(100, (n / maxTick) * 100);
  const caption = options.caption ?? "count";
  const ariaLabel = options.ariaLabel ?? `${n} ${caption}; scale 0 to ${maxTick}`;

  return `
    <div class="simple-int-bar" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <div class="simple-int-bar-value-row">
        <span class="simple-int-bar-count" aria-hidden="true">${escapeHtml(String(n))}</span>
        <span class="simple-int-bar-caption">${escapeHtml(caption)}</span>
      </div>
      <div class="simple-int-bar-axis" aria-hidden="true">
        <span>0</span>
        <span>${escapeHtml(String(maxTick))}</span>
      </div>
      <div class="simple-int-bar-track">
        <div class="simple-int-bar-fill" style="width:${pct}%"></div>
      </div>
    </div>
  `;
}

/**
 * When one sample has a huge latency spike, the Y axis need not swallow the chart.
 * Outliers clamp to the plotted ceiling visually; dots still carry true values for tooltips.
 */
function compressDominantLatencyOutlierCeiling(values) {
  const positive = [...values].map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  if (positive.length < 4) return Math.max(...positive, 0);
  const sorted = [...positive].sort((a, b) => a - b);
  const qi = (p) => {
    if (sorted.length === 1) return sorted[0];
    const u = (p / 100) * (sorted.length - 1);
    const lo = sorted[Math.floor(u)];
    const hi = sorted[Math.ceil(u)];
    const t = u - Math.floor(u);
    return lo + (hi - lo) * t;
  };
  const p88 = qi(88);
  const p92 = qi(92);
  const p94 = qi(94);
  const mx = sorted[sorted.length - 1];
  if (mx <= p94 * 1.95) return mx;
  let candidate = Math.min(mx, Math.max(p94 * 2.1 + p88 * 0.25, mx * 0.46));
  candidate = Math.max(candidate, Math.max(p92 * 1.12, qi(91)));
  return Math.min(candidate, mx);
}

export function lineChart(series, evals, formatter, options = {}) {
  const height = Number(options.chartHeightPx) > 0 ? Number(options.chartHeightPx) : 208;
  const plotLeft = 52;
  const plotRightMargin = 18;
  const plotTop = Number(options.plotTopPx) > 0 ? Number(options.plotTopPx) : 11;
  const chartBottomInset = Number(options.chartBottomInsetPx) > 0 ? Number(options.chartBottomInsetPx) : 20;
  const plotBottom = Math.max(plotTop + 36, height - chartBottomInset);
  const slotMinPx = Number(options.slotMinPx) > 0 ? Number(options.slotMinPx) : 42;
  const seriesLens = Array.isArray(series)
    ? series.map((s) => (Array.isArray(s?.values) ? s.values.length : 0))
    : [];
  const nEvals = Array.isArray(evals) ? evals.length : 0;
  const n = Math.max(seriesLens.length ? Math.max(...seriesLens) : 0, nEvals, 1);

  const plotWidthFloor =
    Number.isFinite(Number(options.plotWidthMinPx)) && Number(options.plotWidthMinPx) >= 0
      ? Number(options.plotWidthMinPx)
      : 560;
  /** Minimum plot width for short series; grows per point → horizontal scroll when needed */
  const plotContentW = Math.max(plotWidthFloor, n * slotMinPx);
  const plotRight = plotLeft + plotContentW;
  const width = plotLeft + plotContentW + plotRightMargin;

  const plotHeight = plotBottom - plotTop;

  const allValues = series.flatMap((item) => item.values).map((value) => Number(value)).filter(Number.isFinite);
  let rawMax = Math.max(0, ...allValues, 0);
  if (options.compressLatencyYAxis && allValues.length >= 4 && rawMax > 0) {
    rawMax = compressDominantLatencyOutlierCeiling(allValues);
  }
  const niceMul = Number(options.yAxisNiceMul) > 0 ? Number(options.yAxisNiceMul) : 1.06;
  const { yMax, ticks } = buildLinearYAxisTicks(rawMax <= 0 ? 1 : rawMax, 4, niceMul);

  function xAt(index) {
    const i = Number(index);
    if (!Number.isFinite(i)) return plotLeft;
    if (n <= 1) return plotLeft + plotContentW / 2;
    return plotLeft + (i / (n - 1)) * plotContentW;
  }

  const lines = series
    .map((item) => {
      const seriesId = slugify(item.label);
      const points = item.values
        .map((value, index) => {
          const x = xAt(index);
          const yVal = Number(value);
          const norm = Number.isFinite(yVal) ? Math.min(Math.max(yVal / yMax, 0), 1) : 0;
          const y = plotBottom - norm * plotHeight;
          return `${x},${y}`;
        })
        .join(" ");
      const dots = item.values
        .map((value, index) => {
          const x = xAt(index);
          const yVal = Number(value);
          const norm = Number.isFinite(yVal) ? Math.min(Math.max(yVal / yMax, 0), 1) : 0;
          const y = plotBottom - norm * plotHeight;
          const label = shortConversationLabel(evals[index] ?? {});
          return `<circle class="chart-point" cx="${x}" cy="${y}" r="3" tabindex="0" data-conversation-id="${escapeHtml(evals[index]?.id ?? "")}" data-series="${escapeHtml(seriesId)}" data-label="${escapeHtml(item.label)}" data-point="${escapeHtml(label)}" data-response-latency-index="${index}" data-value="${escapeHtml(formatter(value))}"></circle>`;
        })
        .join("");
      return `<g class="chart-series" data-series="${escapeHtml(seriesId)}" style="color:${item.color}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />${dots}</g>`;
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
      <div class="chart-line-pane" style="width:${width}px">
        <svg class="eval-chart eval-chart-line" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
          ${baselineX(plotLeft, plotRight, plotBottom)}
          ${horizontalGridAndYTicks}
          ${lines}
        </svg>
        ${chartXAxis(evals, {
          slotted: true,
          insetLeftPx: plotLeft,
          insetWidthPx: plotContentW,
          denseSlotThreshold: Number.isFinite(Number(options.denseAxisSlotThreshold))
            ? Number(options.denseAxisSlotThreshold)
            : undefined,
          denseAxisLabels:
            typeof options.denseAxisLabels === "boolean" ? options.denseAxisLabels : undefined,
          denseItemLabelFormatter:
            typeof options.denseItemLabelFormatter === "function" ? options.denseItemLabelFormatter : undefined,
        })}
      </div>
    </div>
    ${chartAxisLabels(options)}
  `;
}

/** Y-axis ticks for nonnegative integer-ish bin counts displayed as whole numbers. */
export function buildHistogramCountYAxis(rawMax, segments = 4) {
  const n = Number(rawMax);
  const capped = Number.isFinite(n) && n > 0 ? Math.ceil(n) : 1;
  return buildLinearYAxisTicks(capped, segments);
}

/**
 * Pooled-bin histogram over one or more numeric series (`values` arrays).
 * Y-axis counts how many samples fall into each bucket.
 *
 * Linear bins only: option `linearBinLabelStyle: "midpoint"` shows one short value per column (bin center)
 * instead of `low–high` spans; the exact interval stays in bar `<title>` and on hover of the axis tick.
 */
export function histogramChart(seriesList, formatter, options = {}) {
  const histogram = computeHistogram(seriesList ?? [], formatter, options);
  if (!histogram.bins.length) {
    return `<p class="status">Not enough numeric samples for a histogram.</p>${chartAxisLabels(options)}`;
  }

  const categories = histogram.bins.map((bin) =>
    ({
      chartLabel: bin.label,
      ...(bin.axisHoverDetail ? { binRangeTitle: bin.axisHoverDetail } : {}),
    }),
  );
  const countSeries = (seriesList ?? []).map((item, si) => ({
    label: item.label,
    values: histogram.countMatrix[si] ?? histogram.bins.map(() => 0),
    color: item.color ?? "#5a8aaa",
  }));

  return svgGroupedBarChart(countSeries, categories, axisCountFormatter, {
    ...options,
    numericCategoryWidth: Math.max(Number(options.slotMinPx ?? options.minSlotPx ?? 80), Math.round(560 / histogram.bins.length)),
    ariaLabel: options.ariaLabel ?? "Histogram chart",
    yFormatterOverride: axisCountFormatter,
  });
}

/**
 * Stack unrelated histograms vertically. Each panel gets its own bucket edges (avoid pooling
 * different units or scales into one shared histogram, which misleads readers).
 *
 * @param {Array<{title: string, body: string}>} panels
 */
export function stackedHistogramPanels(panels) {
  const list = Array.isArray(panels) ? panels : [];
  if (list.length === 0) return "";
  return `
    <div class="eval-histogram-stack">
      ${list
        .map(
          (p) => `
        <section class="eval-histogram-pane">
          <h3 class="eval-histogram-pane-title">${escapeHtml(p.title)}</h3>
          ${p.body}
        </section>`,
        )
        .join("")}
    </div>
  `;
}

function axisCountFormatter(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? String(n) : "0";
}

function computeHistogram(seriesList, formatter, options) {
  const series = (seriesList ?? []).filter((s) => s && Array.isArray(s.values));
  if (series.length === 0) return { bins: [], countMatrix: [] };

  const pooled = series.flatMap((s) => s.values.map((v) => Number(v)).filter((n) => Number.isFinite(n)));
  if (pooled.length === 0) return { bins: [], countMatrix: [] };

  const wantsInteger =
    options.binMode === "integer" ||
    (options.binMode !== "linear" &&
      pooled.every((n) => Number.isFinite(n) && Number.isInteger(n) && n >= 0) &&
      Math.max(...pooled, 0) <= Number(options.integerMaxAuto ?? 64));

  const bins = wantsInteger ? buildIntegerCountBins(pooled, options) : buildLinearBins(pooled, formatter, options);
  const countMatrix = series.map((s) => bins.map((bin) => countInBin(s.values, bin)));

  return { bins, countMatrix };
}

function countInBin(values, bin) {
  return values.filter((value) => valueInBin(Number(value), bin)).length;
}

function valueInBin(value, bin) {
  if (!Number.isFinite(value)) return false;
  if (bin.kind === "integer") return value >= bin.low && value <= bin.high;
  if (value < bin.low) return false;
  if (bin.inclusiveRightEdge) return value <= bin.high;
  return value < bin.high;
}

function buildIntegerCountBins(values, options) {
  const nums = values.map(Number).filter(Number.isFinite);
  const maxObserved = nums.length === 0 ? 0 : Math.max(0, ...nums);
  const cap = Number(options.integerCap ?? 18);
  const upper = Math.min(Math.ceil(maxObserved), cap);

  /** @type {Array<{kind:'integer'; low:number; high:number; label:string}>} */
  const bins = [];

  let v = 0;
  while (v <= upper) {
    bins.push({
      kind: "integer",
      low: v,
      high: v,
      label: String(v),
    });
    if (bins.length >= 36) break;
    v++;
  }

  if (maxObserved > upper) {
    bins.push({
      kind: "integer",
      low: upper + 1,
      high: Infinity,
      label: `${upper + 1}+`,
    });
  }

  return bins;
}

function buildLinearBins(pooled, formatter, options) {
  let minVal = Math.min(...pooled);
  let maxVal = Math.max(...pooled);

  if (!Number.isFinite(minVal)) minVal = 0;
  if (!Number.isFinite(maxVal)) maxVal = 1;

  let spread = maxVal - minVal;
  if (spread <= 0) {
    const pad =
      Math.max(Math.abs(minVal) * 0.002, minVal !== 0 ? Math.abs(minVal) * 0.002 : Math.abs(maxVal) * 0.002 || 0.001) ||
      0.001;
    const center = minVal !== 0 ? minVal : maxVal !== 0 ? maxVal : 1;

    const labelCenter = formatter(center);
    const labelStyle = options.linearBinLabelStyle ?? "range";
    /** @type {Array<{kind:'linear'; low:number; high:number; inclusiveRightEdge:boolean; label:string; axisHoverDetail?:string}>} */
    return [
      {
        kind: "linear",
        low: center - pad,
        high: center + pad,
        inclusiveRightEdge: true,
        label: labelCenter,
        ...(labelStyle === "midpoint"
          ? { axisHoverDetail: `${formatter(center - pad)}\u2009\u2013\u2009${formatter(center + pad)}` }
          : {}),
      },
    ];
  }

  let binCount = Number(options.binCount);
  if (!Number.isFinite(binCount) || binCount < 3) binCount = 11;
  binCount = Math.min(Math.max(binCount, 4), 24);

  const edges = [];

  let iEdge = 0;
  while (iEdge <= binCount) {

    edges.push(minVal + (spread * iEdge) / binCount);

    iEdge++;
  }

  /** @type {Array<{kind:'linear'; low:number; high:number; inclusiveRightEdge:boolean; label:string; axisHoverDetail?:string}>} */
  const bins = [];

  /** @type {Set<string>} */
  const labelsSeen = new Set();

  const labelStyle = options.linearBinLabelStyle ?? "range";


  let b = 0;
  while (b < binCount) {
    const low = edges[b];
    const high = edges[b + 1];
    const rangeLabel = `${formatter(low)}\u2009\u2013\u2009${formatter(high)}`;
    let label = rangeLabel;
    if (labelStyle === "midpoint") {
      const mid = (low + high) / 2;
      label = formatter(mid);
    }

    while (labelsSeen.has(label)) {
      label += ` ·${b}`;
    }

    labelsSeen.add(label);

    const isLast = b === binCount - 1;

    bins.push({
      kind: "linear",
      low,
      high: isLast ? Math.max(high, maxVal) : high,
      inclusiveRightEdge: isLast,
      label,
      ...(labelStyle === "midpoint" ? { axisHoverDetail: rangeLabel } : {}),
    });

    b++;
  }

  return bins;
}

export function groupedBarChart(series, evals, formatter, options = {}) {
  return svgGroupedBarChart(series, evals ?? [], formatter, options);
}

function svgGroupedBarChart(series, categories, formatter, options = {}) {
  const height = Number(options.chartHeightPx) > 0 ? Number(options.chartHeightPx) : 218;
  const plotLeft = 48;
  const plotRightMargin = 18;
  const plotTop = 11;
  const plotBottom = height - 21;
  const plotWidthDefault = 560 - plotLeft - plotRightMargin;
  /** When set (e.g. conversation eval column), clamps bar-plot horizontal span; aligns with lineChart plotWidthMinPx intent */
  const plotWidthBaseRaw =
    Number.isFinite(Number(options.plotWidthMinPx)) && Number(options.plotWidthMinPx) >= 0
      ? Number(options.plotWidthMinPx)
      : plotWidthDefault;
  const plotWidthBase = Math.max(160, Math.min(plotWidthBaseRaw, 960));

  const cats = categories ?? [];
  const nCat = Math.max(cats.length, 1);
  const seriesList = Array.isArray(series) ? series.filter((s) => s && Array.isArray(s.values)) : [];
  const nSer = Math.max(seriesList.length, 1);

  const numericValues = seriesList.flatMap((item) => item.values.map((value) => Number(value ?? 0))).filter((value) => Number.isFinite(value));
  const rawMax = Math.max(0, ...numericValues, 0);

  const yTickFormatter = typeof options.yFormatterOverride === "function" ? options.yFormatterOverride : formatter;

  const useCountY = options.yFormatterOverride === axisCountFormatter;

  const axis = useCountY ? buildHistogramCountYAxis(rawMax, 4) : buildLinearYAxisTicks(rawMax <= 0 ? 1 : rawMax, 4);
  const yMax = axis.yMax;
  const ticks = axis.ticks;

  const slotMin = Number(options.numericCategoryWidth ?? options.minSlotPx ?? options.slotMinPx ?? 44);
  const slotW = Math.max(slotMin, plotWidthBase / nCat);
  const plotContentW = slotW * nCat;
  const width = plotLeft + plotContentW + plotRightMargin;
  const plotRight = width - plotRightMargin;
  const plotHeight = plotBottom - plotTop;

  const innerPad = 6;
  const groupUsable = Math.max(8, slotW - innerPad * 2);
  const band = groupUsable / nSer;
  const barGap = band * 0.1;
  const barW = Math.max(2, band - barGap);
  const packedW = (nSer - 1) * band + barW;

  const bars = cats
    .map((cat, colIndex) =>
      seriesList
        .map((entry, si) => {
          const value = Number(entry.values[colIndex] ?? 0);
          const seriesId = slugify(entry.label);
          const frac = yMax > 0 && Number.isFinite(value) ? Math.min(Math.max(value / yMax, 0), 1) : 0;
          const h = frac * plotHeight;
          /** Center the bar cluster on the slot midpoint (matches slotted axis grid). */
          const slotMidX = plotLeft + colIndex * slotW + slotW / 2;
          const x0 = slotMidX - barGap / 2 - packedW / 2;
          const x = x0 + si * band + barGap / 2;
          const yRect = plotBottom - h;
          const titlePlain = `${entry.label}: ${yTickFormatter(value)} · ${shortConversationLabel(cat)}${
            cat?.binRangeTitle ? `\n${cat.binRangeTitle}` : ""
          }`;
          const convRaw = cat?.id != null ? String(cat.id).trim() : "";
          const convAttr = convRaw ? ` data-conversation-id="${escapeHtml(convRaw)}"` : "";

          return `
            <rect class="chart-bar-rect" tabindex="0"
              x="${x}" y="${yRect}" width="${barW}" height="${Math.max(h, 0)}"
              rx="2" ry="2" fill="${escapeHtml(entry.color)}" style="color:${entry.color}"
              data-series="${escapeHtml(seriesId)}"${convAttr}
              data-label="${escapeHtml(entry.label)}"
              data-point="${escapeHtml(shortConversationLabel(cat))}"
              data-value="${escapeHtml(yTickFormatter(value))}"
            >
              <title>${escapeHtml(titlePlain)}</title>
            </rect>
          `;
        })
        .join(""),
    )
    .join("");

  const grid = renderHorizontalGridAndYTicks({
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    yMax,
    ticks,
    formatter: yTickFormatter,
  });

  return `
    ${options.omitChartLegend ? "" : chartLegend(seriesList)}
    <div class="chart-scroll chart-chart-bar-scroll">
      <div
        class="chart-bar-pane"
        style="
          flex: 0 0 auto;
          width:${width}px;
          --chart-slots:${cats.length || 1}
        ">
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"
          class="eval-chart eval-chart-grouped" role="img" aria-label="${escapeHtml(options.ariaLabel ?? "Grouped bar chart")}">
          ${baselineX(plotLeft, plotRight, plotBottom)}
          ${grid}
          ${bars}
        </svg>
        ${chartXAxis(cats, {
          slotted: true,
          insetLeftPx: plotLeft,
          insetWidthPx: plotContentW,
          categoryRangeHints: cats.some((c) => Boolean(c?.binRangeTitle)),
        })}
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

function buildLinearYAxisTicks(rawMax, segments = 4, niceMul = 1.06) {
  const mul = Number(niceMul) > 0 ? Number(niceMul) : 1.06;
  const yMax = rawMax <= 0 ? 1 : niceUpperBound(rawMax * mul);
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

function trimConversationIdFromElement(el) {
  const raw = el?.dataset?.conversationId;
  if (raw === undefined || raw === null) return "";
  const s = String(raw).trim();
  return s;
}

/** When opening a conversation from dashboard charts, jump to QA when plot is corrections/failures-centric. */
function evalChartNavigationHash(target) {
  const cardTitle = (target.closest(".chart-card")?.querySelector("h2")?.textContent ?? "").toLowerCase();
  const series = (target.dataset.label ?? "").toLowerCase();
  if (cardTitle.includes("correction") || cardTitle.includes("failure")) return "#quality-events";
  if (series.includes("correction") || series.includes("failure")) return "#quality-events";
  return "";
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

      /** Per-turn latency chart: delegated handler elsewhere scrolls the transcript instead of navigating. */
      if (point.closest("[data-latency-turn-chart]")) {
        return;
      }

      const conversationId = trimConversationIdFromElement(point);
      if (!conversationId) return;

      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        window.open(`/evals/conversation?id=${encodeURIComponent(conversationId)}${evalChartNavigationHash(point)}`, "_blank");
        return;
      }

      window.location.href = `/evals/conversation?id=${encodeURIComponent(conversationId)}${evalChartNavigationHash(point)}`;
    });
  });

  root.querySelectorAll(".chart-bar-rect").forEach((rect) => {
    rect.addEventListener("pointerenter", (event) => showChartTooltip(event, tooltip));
    rect.addEventListener("pointermove", (event) => positionChartTooltip(event, tooltip));
    rect.addEventListener("pointerleave", () => hideChartTooltip(tooltip));
    rect.addEventListener("focus", (event) => showChartTooltip(event, tooltip));
    rect.addEventListener("blur", () => hideChartTooltip(tooltip));
    rect.addEventListener("click", (event) => {
      const conversationId = trimConversationIdFromElement(rect);
      if (!conversationId) return;

      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        window.open(`/evals/conversation?id=${encodeURIComponent(conversationId)}${evalChartNavigationHash(rect)}`, "_blank");
        return;
      }

      window.location.href = `/evals/conversation?id=${encodeURIComponent(conversationId)}${evalChartNavigationHash(rect)}`;
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

function chartXAxis(evals, axisOptions = {}) {
  const list = evals ?? [];
  const slots = Math.max(list.length, 1);
  const thresh = axisOptions.denseSlotThreshold;
  const denseThreshold = Number.isFinite(Number(thresh)) && Number(thresh) > 0 ? Number(thresh) : 16;
  const denseDefault = slots >= denseThreshold;
  const denseFormatter = typeof axisOptions.denseItemLabelFormatter === "function";
  const denseExplicit = typeof axisOptions.denseAxisLabels === "boolean" ? axisOptions.denseAxisLabels : undefined;
  const dense = denseExplicit === undefined ? denseDefault || denseFormatter : denseExplicit;

  let cls = axisOptions.slotted ? "chart-x-axis chart-x-axis-slotted" : "chart-x-axis";
  if (axisOptions.slotted && dense) cls += " chart-x-axis-dense";
  if (axisOptions.categoryRangeHints) cls += " chart-x-axis-compactBins";

  const labels =
    list
      .map((item, index) => {
        const denseFormat = dense && denseFormatter;
        const displayPlain = denseFormat ? axisOptions.denseItemLabelFormatter(item, index) : shortConversationLabel(item);
        let titleRaw = "";
        if (typeof item.binRangeTitle === "string" && item.binRangeTitle.trim()) {
          titleRaw = item.binRangeTitle.trim();
        } else if (denseFormat) {
          titleRaw =
            typeof item.axisDenseTitle === "string" && item.axisDenseTitle.trim()
              ? item.axisDenseTitle.trim()
              : shortConversationLabel(item);
        }
        const text = escapeHtml(displayPlain);
        const tipAttr = titleRaw.trim() ? ` title="${escapeHtml(titleRaw.trim())}"` : "";
        return `<span${tipAttr}>${text}</span>`;
      })
      .join("") || `<span>n/a</span>`;

  const innerAttrs = axisOptions.slotted ? ` style="--chart-slots:${slots};width:100%"` : "";
  let row = `<div class="${cls}"${innerAttrs}>${labels}</div>`;

  if (
    axisOptions.slotted &&
    typeof axisOptions.insetLeftPx === "number" &&
    typeof axisOptions.insetWidthPx === "number"
  ) {
    const wrapStyle = `flex:0 0 auto;margin-left:${axisOptions.insetLeftPx}px;width:${Math.max(axisOptions.insetWidthPx, 88)}px;`;
    row = `<div class="chart-x-axis-strip" style="${wrapStyle}">${row}</div>`;
  }

  return `
    ${row}
  `;
}

function chartAxisLabels(options) {
  if (!options.xLabel && !options.yLabel) return "";
  const stacked = options.chartAxisLegendStack === true;
  const cls = stacked ? "chart-axis-labels chart-axis-labels-stack" : "chart-axis-labels";
  const yEsc = escapeHtml(options.yLabel ?? "value");
  const xEsc = escapeHtml(options.xLabel ?? "items");
  return `
    <div class="${cls}">
      ${options.yLabel ? `<span class="chart-axis-y-legend">${yEsc}</span>` : ``}
      ${options.xLabel ? `<span class="chart-axis-x-legend">${xEsc}</span>` : ``}
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
  if (!item || typeof item !== "object") return "Call";

  let extra = "";
  if (typeof item.label === "string" && item.label.trim()) {
    const trimmed = item.label.trim();
    const chart = item.chartLabel != null ? String(item.chartLabel).trim() : "";
    if (trimmed !== chart && trimmed !== String(item.listOrdinal ?? "").trim()) {
      extra = ` (${trimmed})`;
    }
  }

  if (item.listOrdinal != null && Number.isFinite(Number(item.listOrdinal))) {
    return String(item.listOrdinal) + extra;
  }

  const base = item.chartLabel ?? item.displayId ?? shortId(item.id) ?? "Call";
  return base + extra;
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
