import { displayVoiceModel } from "./evalMetrics.js";

const conversationListEl = document.querySelector("#conversationList");
const conversationDetailEl = document.querySelector("#conversationDetail");
const refreshButton = document.querySelector("#refreshButton");

let selectedConversationId;
/** Newest-first order from last /api/conversations response (matches list labels). */
let lastConversationSummaries = [];

refreshButton.addEventListener("click", loadConversations);
await loadConversations();

async function loadConversations() {
  const response = await fetch("/api/conversations");
  const data = await response.json();

  if (!response.ok) {
    conversationListEl.textContent = data.error ?? "Failed to load conversations.";
    return;
  }

  if (data.conversations.length === 0) {
    conversationListEl.textContent = "No conversations saved yet.";
    conversationDetailEl.textContent = "Complete a call, press Stop, then refresh this page.";
    return;
  }

  lastConversationSummaries = data.conversations;

  conversationListEl.innerHTML = data.conversations
    .map(
      (conversation, index) => `
        <button class="list-item ${conversation.id === selectedConversationId ? "selected" : ""}" data-id="${conversation.id}">
          <strong>#${index + 1} · ${escapeHtml(conversation.customerName ?? "Unknown customer")}</strong>
          <span>${escapeHtml(conversation.mode ?? "unknown")} · ${formatDate(conversation.startedAt)}</span>
          <span>${escapeHtml(displayVoiceModel(conversation.voiceModel))}</span>
          <span>${conversation.transcriptCount} transcripts · ${conversation.toolCallCount} tool calls</span>
        </button>
      `,
    )
    .join("");

  conversationListEl.querySelectorAll("[data-id]").forEach((button) => {
    button.addEventListener("click", () => loadConversation(button.dataset.id));
  });
}

async function loadConversation(id) {
  selectedConversationId = id;
  await loadConversations();

  const response = await fetch(`/api/conversations/${id}`);
  const data = await response.json();

  if (!response.ok) {
    conversationDetailEl.textContent = data.error ?? "Failed to load conversation.";
    return;
  }

  renderConversation(data.conversation, data.audio);
}

function renderConversation(conversation, audio) {
  const transcripts = conversation.transcripts ?? [];
  const toolCalls = conversation.toolCalls ?? [];
  const fullTranscript = conversation.fullTranscript ?? buildFullTranscript(conversation, transcripts);
  const transcriptGroups = groupTranscriptWithToolCalls(transcripts, toolCalls);
  conversationDetailEl.innerHTML = `
    <div>
      <p><strong>#</strong> ${listNumberForConversation(conversation.id)}</p>
      <p><strong>Customer:</strong> ${escapeHtml(conversation.customerName ?? "Unknown")}</p>
      <p><strong>Mode:</strong> ${escapeHtml(conversation.mode ?? "unknown")}</p>
      <p><strong>Voice model:</strong> ${escapeHtml(displayVoiceModel(conversation.voiceModel))}</p>
      <p><strong>Started:</strong> ${formatDate(conversation.startedAt)}</p>
      <p><strong>Ended:</strong> ${formatDate(conversation.endedAt)}</p>
      <p class="status">${escapeHtml(conversation.recordingNote ?? "")}</p>
      <p class="status">${escapeHtml(conversation.transcriptNote ?? "")}</p>
    </div>

    <div class="floating-audio-player">
      <div>
        <span class="eyebrow">Conversation audio</span>
        <strong>Click any transcript line to jump</strong>
      </div>
      <audio id="conversationAudio" controls src="${audio.conversation}"></audio>
    </div>

    <h3>Transcript</h3>
    <div class="stack">
      ${
        transcriptGroups.length
          ? transcriptGroups.map((group) => renderTranscriptGroup(group, conversation)).join("")
          : "<p>No transcript entries saved.</p>"
      }
    </div>

    <h3>Full Transcript</h3>
    <pre>${escapeHtml(fullTranscript)}</pre>
  `;

  conversationDetailEl.querySelectorAll("[data-audio-track]").forEach((row) => {
    row.addEventListener("click", () => {
      const audioEl = document.querySelector("#conversationAudio");
      if (!audioEl) return;
      audioEl.currentTime = Number(row.dataset.timestampMs ?? 0) / 1000;
      audioEl.play();
    });
  });
}

function listNumberForConversation(id) {
  const i = lastConversationSummaries.findIndex((c) => c.id === id);
  return i >= 0 ? String(i + 1) : "—";
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
      <button class="transcript-row" data-audio-track="${entry.audioTrack}" data-timestamp-ms="${entry.timestampMs}">
        <span class="speaker-line">
          <strong>${escapeHtml(transcriptSpeaker(entry, conversation))}:</strong>
          ${escapeHtml(entry.text)}
        </span>
        <span class="timestamp">${formatOffset(entry.timestampMs)}</span>
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
    return `
      <div class="rag-results">
        ${payload.results.map(renderRagResult).join("")}
      </div>
    `;
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

  if (args.field) {
    details.push(`field: ${args.field}`);
  }
  if (args.value) {
    details.push(`value: ${formatToolValue(args.value)}`);
  }
  if (!args.field && args.query) {
    details.push(`query: ${args.query}`);
  }
  if (!args.field && args.vin) {
    details.push(`vin: ${args.vin}`);
  }
  if (!details.length && Object.keys(args).length) {
    Object.entries(args).forEach(([key, value]) => {
      details.push(`${key}: ${formatToolValue(value)}`);
    });
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

  if (rawRole === "agent" || rawRole === "assistant" || entry.role === "Lizzy") {
    return "Lizzy";
  }
  if (rawRole === "user" || rawRole === "customer" || entry.role === "Customer") {
    return customerFirstName || "Customer";
  }
  return entry.speaker ?? entry.role ?? "Speaker";
}

function formatDate(value) {
  if (!value) return "unknown";
  return new Date(value).toLocaleString();
}

function formatOffset(ms) {
  const totalSeconds = Math.floor((ms ?? 0) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
