const CUSTOM_MODELS_KEY = "nimcheck.customModels.v1";

const state = {
  filter: "all",
  data: null,
  pollTimer: null,
  cardById: new Map(),
  customModels: loadCustomModels()
};

const els = {
  refreshButton: document.querySelector("#refreshButton"),
  autoRefresh: document.querySelector("#autoRefresh"),
  modelForm: document.querySelector("#modelForm"),
  modelIdInput: document.querySelector("#modelIdInput"),
  modelNameInput: document.querySelector("#modelNameInput"),
  modelHelp: document.querySelector("#modelHelp"),
  usableMetric: document.querySelector("#usableMetric"),
  usableSub: document.querySelector("#usableSub"),
  p50Metric: document.querySelector("#p50Metric"),
  p95Metric: document.querySelector("#p95Metric"),
  lastCheckMetric: document.querySelector("#lastCheckMetric"),
  nextCheckMetric: document.querySelector("#nextCheckMetric"),
  notice: document.querySelector("#notice"),
  tabs: document.querySelector("#tabs"),
  serverStamp: document.querySelector("#serverStamp"),
  modelGrid: document.querySelector("#modelGrid"),
  template: document.querySelector("#modelCardTemplate")
};

els.refreshButton.addEventListener("click", () => loadStatus({ manual: true }));
els.modelForm.addEventListener("submit", addCustomModel);
els.autoRefresh.addEventListener("change", () => {
  if (els.autoRefresh.checked) startPolling();
  else stopPolling();
});

els.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter;
  for (const tab of els.tabs.querySelectorAll(".tab")) {
    tab.classList.toggle("is-active", tab === button);
  }
  render();
});

startPolling();
loadStatus();

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(loadStatus, 60_000);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function loadStatus(options = {}) {
  els.refreshButton.disabled = true;
  try {
    const response = await fetch(`./status.json?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    render();
    if (options.manual) showNotice("Status file refreshed.");
  } catch (error) {
    showNotice(`Status file failed to load: ${error.message}`);
  } finally {
    window.setTimeout(() => {
      els.refreshButton.disabled = false;
    }, 300);
  }
}

function addCustomModel(event) {
  event.preventDefault();
  const id = els.modelIdInput.value.trim();
  const name = els.modelNameInput.value.trim();

  if (!isValidModelId(id)) {
    showNotice("Use a model ID like provider/model-name.");
    return;
  }

  const existing = state.customModels.find((model) => model.id === id);
  if (existing) {
    existing.name = name || existing.name || titleFromId(id);
  } else {
    state.customModels.push({
      id,
      name: name || titleFromId(id),
      provider: providerFromId(id),
      tier: "Local Watch"
    });
  }

  state.customModels.sort((a, b) => a.id.localeCompare(b.id));
  saveCustomModels();
  els.modelForm.reset();
  showNotice("Added to local watchlist.");
  render();
}

function removeCustomModel(id) {
  state.customModels = state.customModels.filter((model) => model.id !== id);
  saveCustomModels();
  showNotice("Removed from local watchlist.");
  render();
}

function render() {
  if (!state.data) return;
  const data = mergeCustomModels(state.data);

  els.usableMetric.textContent = `${data.summary.usable}/${data.summary.total}`;
  els.usableSub.textContent = data.checking ? "checking" : `${data.summary.down} down`;
  els.p50Metric.textContent = formatLatency(data.summary.p50LatencyMs);
  els.p95Metric.textContent = formatLatency(data.summary.p95LatencyMs);
  els.lastCheckMetric.textContent = relativeTime(data.lastRunFinishedAt || data.generatedAt);
  els.nextCheckMetric.textContent = data.nextRunAt ? `next around ${relativeTime(data.nextRunAt)}` : "no schedule";
  els.serverStamp.textContent = data.generatedAt ? `generated ${relativeTime(data.generatedAt)}` : data.endpoint;
  els.modelHelp.textContent = `${state.customModels.length} local`;

  if (!data.configured) {
    showNotice("Scheduled checks need NVIDIA_API_KEY.");
  }

  const models = filteredModels(data.models);
  const visibleIds = new Set(models.map((model) => model.id));

  for (const [id, card] of state.cardById.entries()) {
    if (!visibleIds.has(id)) {
      card.remove();
      state.cardById.delete(id);
    }
  }

  if (models.length === 0) {
    if (!els.modelGrid.querySelector(".empty")) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No models in this view.";
      els.modelGrid.append(empty);
    }
    return;
  }

  els.modelGrid.querySelector(".empty")?.remove();
  for (const model of models) {
    const card = state.cardById.get(model.id) || createModelCard(model);
    updateModelCard(card, model, data.settings.slowThresholdMs);
    if (!card.isConnected) els.modelGrid.append(card);
  }
}

function mergeCustomModels(data) {
  const checkedIds = new Set((data.models || []).map((model) => model.id));
  const checkedModels = (data.models || []).map((model) => ({
    ...model,
    customPinned: state.customModels.some((custom) => custom.id === model.id),
    isCustomOnly: false
  }));
  const customOnlyModels = state.customModels
    .filter((model) => !checkedIds.has(model.id))
    .map((model) => ({
      ...model,
      latest: {
        status: "watching",
        message: "Waiting for scheduled data.",
        checkedAt: null,
        latencyMs: null,
        totalLatencyMs: null,
        ttftMs: null,
        tokensPerSecond: null,
        outputTokens: null,
        httpStatus: null,
        inFlightRequests: 0,
        peakInFlightRequests: 0,
        answerPreview: ""
      },
      history: [],
      metrics: emptyMetrics(),
      consecutiveFailures: 0,
      customPinned: true,
      isCustomOnly: true
    }));

  const models = [...checkedModels, ...customOnlyModels].sort((a, b) => {
    const statusOrder = statusRank(a.latest.status) - statusRank(b.latest.status);
    return statusOrder || a.name.localeCompare(b.name);
  });

  return {
    ...data,
    models,
    summary: summarize(models)
  };
}

function summarize(models) {
  const usable = models.filter((row) => ["healthy", "slow"].includes(row.latest.status));
  const healthy = models.filter((row) => row.latest.status === "healthy");
  const down = models.filter((row) => ["queued", "timeout", "error"].includes(row.latest.status));
  const completed = models.filter((row) =>
    ["healthy", "slow", "queued", "timeout", "error", "not_configured"].includes(row.latest.status)
  );
  const latencies = usable
    .map((row) => row.latest.totalLatencyMs ?? row.latest.latencyMs)
    .filter((latency) => typeof latency === "number")
    .sort((a, b) => a - b);

  return {
    total: models.length,
    completed: completed.length,
    healthy: healthy.length,
    usable: usable.length,
    slow: models.filter((row) => row.latest.status === "slow").length,
    down: down.length,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95)
  };
}

function createModelCard(model) {
  const card = els.template.content.firstElementChild.cloneNode(true);
  card.querySelector(".mini-button").addEventListener("click", () => {
    removeCustomModel(card.dataset.modelId);
  });
  state.cardById.set(model.id, card);
  return card;
}

function updateModelCard(card, model, slowThresholdMs) {
  const latest = model.latest;
  const metrics = normalizeMetrics(model);
  const status = latest.status || "pending";
  card.dataset.modelId = model.id;
  card.className = `model-card status-${status}`;
  card.querySelector("h2").textContent = model.name;
  card.querySelector(".model-id").textContent = model.id;
  card.querySelector(".provider").textContent = `${model.provider} / ${model.tier}`;
  card.querySelector(".status-pill b").textContent = labelForStatus(status);
  card.querySelector('[data-field="ttft"]').textContent = formatLatency(metrics.ttftMs);
  card.querySelector('[data-field="totalLatency"]').textContent = formatLatency(metrics.totalLatencyMs);
  card.querySelector('[data-field="tps"]').textContent = formatTps(metrics.tokensPerSecond);
  card.querySelector('[data-field="timeoutRate"]').textContent = formatPercent(metrics.timeoutRate);
  card.querySelector('[data-field="http5xxRate"]').textContent = formatPercent(metrics.http5xxRate);
  card.querySelector('[data-field="http429Rate"]').textContent = formatPercent(metrics.http429Rate);
  card.querySelector('[data-field="modelP95"]').textContent = formatLatency(metrics.p95LatencyMs);
  card.querySelector('[data-field="inFlight"]').textContent = formatInFlight(
    metrics.inFlightRequests,
    metrics.peakInFlightRequests
  );
  card.querySelector('[data-field="message"]').textContent =
    latest.message || latest.answerPreview || relativeTime(latest.checkedAt);

  const button = card.querySelector(".mini-button");
  button.hidden = !model.isCustomOnly;
  drawSparkline(card.querySelector("canvas"), model.history || [], slowThresholdMs);
}

function filteredModels(models) {
  if (state.filter === "all") return models;
  if (state.filter === "down") {
    return models.filter((model) => ["queued", "timeout", "error", "not_configured"].includes(model.latest.status));
  }
  if (state.filter === "watching") {
    return models.filter((model) => model.latest.status === "watching" || model.customPinned);
  }
  return models.filter((model) => model.latest.status === state.filter);
}

function drawSparkline(canvas, history, slowThresholdMs) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = "#26312a";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height - 18);
  ctx.lineTo(width, height - 18);
  ctx.stroke();

  if (!history.length) {
    ctx.fillStyle = "#89978f";
    ctx.font = "12px system-ui";
    ctx.fillText("waiting", 14, 45);
    return;
  }

  const maxLatency = Math.max(
    slowThresholdMs,
    ...history.map((item) => item.totalLatencyMs ?? item.latencyMs ?? 0),
    1000
  );
  const step = history.length > 1 ? width / (history.length - 1) : width;
  const points = history.map((item, index) => {
    const latency = item.totalLatencyMs ?? item.latencyMs ?? maxLatency;
    const y = height - 12 - Math.min(latency / maxLatency, 1) * (height - 24);
    return [index * step, y, item.status];
  });

  ctx.strokeStyle = "#7ed2ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  for (const [x, y, status] of points) {
    ctx.fillStyle = colorForStatus(status);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function colorForStatus(status) {
  if (status === "healthy") return "#70e09a";
  if (status === "slow") return "#f3c968";
  if (status === "checking" || status === "pending" || status === "watching") return "#7ed2ff";
  return "#ff746c";
}

function labelForStatus(status) {
  return {
    healthy: "Healthy",
    slow: "Slow",
    queued: "Queued",
    timeout: "Timeout",
    error: "Error",
    checking: "Checking",
    pending: "Pending",
    not_configured: "Config",
    watching: "Watch"
  }[status] || status;
}

function statusRank(status) {
  return {
    healthy: 1,
    slow: 2,
    timeout: 3,
    error: 4,
    queued: 5,
    watching: 6,
    not_configured: 7,
    pending: 8
  }[status] || 9;
}

function formatLatency(value) {
  if (typeof value !== "number") return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${value}ms`;
}

function formatTps(value) {
  if (typeof value !== "number") return "-";
  return value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
}

function formatPercent(value) {
  if (typeof value !== "number") return "-";
  return value === 0 ? "0%" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatInFlight(current, peak) {
  const safeCurrent = typeof current === "number" ? current : 0;
  if (typeof peak === "number" && peak > 0) return `${safeCurrent}/${peak}`;
  return `${safeCurrent}`;
}

function relativeTime(value) {
  if (!value) return "-";
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "-";
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const suffix = diff > 0 ? "from now" : "ago";
  if (abs < 1000) return "now";
  if (abs < 60_000) return `${Math.round(abs / 1000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ${suffix}`;
  return `${Math.round(abs / 3_600_000)}h ${suffix}`;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * values.length) - 1;
  return values[Math.max(0, Math.min(values.length - 1, index))];
}

function normalizeMetrics(model) {
  const latest = model.latest || {};
  const history = model.history || [];
  const latencies = history
    .map((entry) => entry.totalLatencyMs ?? entry.latencyMs)
    .filter((latency) => typeof latency === "number")
    .sort((a, b) => a - b);
  const existing = model.metrics || latest.metrics || {};

  return {
    ttftMs: existing.ttftMs ?? latest.ttftMs ?? null,
    totalLatencyMs: existing.totalLatencyMs ?? latest.totalLatencyMs ?? latest.latencyMs ?? null,
    tokensPerSecond: existing.tokensPerSecond ?? latest.tokensPerSecond ?? null,
    outputTokens: existing.outputTokens ?? latest.outputTokens ?? null,
    timeoutRate: existing.timeoutRate ?? rateFor(history, (entry) => entry.status === "timeout"),
    http5xxRate:
      existing.http5xxRate ??
      rateFor(history, (entry) => typeof entry.httpStatus === "number" && entry.httpStatus >= 500),
    http429Rate: existing.http429Rate ?? rateFor(history, (entry) => entry.httpStatus === 429),
    p95LatencyMs: existing.p95LatencyMs ?? percentile(latencies, 95),
    inFlightRequests: existing.inFlightRequests ?? latest.inFlightRequests ?? 0,
    peakInFlightRequests: existing.peakInFlightRequests ?? latest.peakInFlightRequests ?? 0
  };
}

function emptyMetrics() {
  return {
    ttftMs: null,
    totalLatencyMs: null,
    tokensPerSecond: null,
    outputTokens: null,
    timeoutRate: null,
    http5xxRate: null,
    http429Rate: null,
    p95LatencyMs: null,
    inFlightRequests: 0,
    peakInFlightRequests: 0
  };
}

function rateFor(history, predicate) {
  if (!history.length) return null;
  const matches = history.filter(predicate).length;
  return Math.round((matches / history.length) * 1000) / 10;
}

function isValidModelId(id) {
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/i.test(id);
}

function titleFromId(id) {
  const tail = id.split("/").pop() || id;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerFromId(id) {
  const provider = id.split("/")[0];
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "Unknown";
}

function loadCustomModels() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_MODELS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((model) => model && isValidModelId(model.id)).map((model) => ({
      id: model.id,
      name: model.name || titleFromId(model.id),
      provider: model.provider || providerFromId(model.id),
      tier: model.tier || "Local Watch"
    }));
  } catch {
    return [];
  }
}

function saveCustomModels() {
  localStorage.setItem(CUSTOM_MODELS_KEY, JSON.stringify(state.customModels));
}

function showNotice(message) {
  els.notice.textContent = message;
  els.notice.classList.remove("hidden");
}
