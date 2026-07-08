import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const modelsPath = join(rootDir, "config", "models.json");
const statusPath = join(rootDir, "public", "status.json");

await loadEnvFile();

const CHECK_INTERVAL_MS = integerFromEnv("CHECK_INTERVAL_MS", 10 * 60_000);
const REQUEST_TIMEOUT_MS = integerFromEnv("REQUEST_TIMEOUT_MS", 20_000);
const SLOW_THRESHOLD_MS = integerFromEnv("SLOW_THRESHOLD_MS", 8_000);
const MODEL_CONCURRENCY = integerFromEnv("MODEL_CONCURRENCY", 3);
const PROBE_MAX_TOKENS = integerFromEnv("PROBE_MAX_TOKENS", 32);
const NVIDIA_ENDPOINT = process.env.NVIDIA_ENDPOINT || "https://integrate.api.nvidia.com/v1/chat/completions";
const rawApiKey = process.env.NVIDIA_API_KEY || "";
const NVIDIA_API_KEY = rawApiKey && rawApiKey !== "nvapi-your-key-here" ? rawApiKey : "";
const HISTORY_LIMIT = integerFromEnv("HISTORY_LIMIT", 48);

const models = await loadModels();
const previousStatus = await loadPreviousStatus();
const previousById = new Map((previousStatus?.models || []).map((model) => [model.id, model]));
const runStartedAt = new Date().toISOString();
const results = new Map();
let inFlightRequests = 0;
let peakInFlightRequests = 0;

if (NVIDIA_API_KEY) {
  await runWithConcurrency(models, MODEL_CONCURRENCY, async (model) => {
    inFlightRequests += 1;
    peakInFlightRequests = Math.max(peakInFlightRequests, inFlightRequests);
    const inFlightAtStart = inFlightRequests;
    try {
      results.set(model.id, await probeModel(model, inFlightAtStart));
    } finally {
      inFlightRequests -= 1;
    }
  });
} else {
  for (const model of models) {
    results.set(model.id, {
      status: "not_configured",
      message: "NVIDIA_API_KEY is not set.",
      checkedAt: runStartedAt,
      latencyMs: null,
      totalLatencyMs: null,
      ttftMs: null,
      tokensPerSecond: null,
      outputTokens: null,
      httpStatus: null,
      inFlightRequests: 0,
      peakInFlightRequests: 0,
      answerPreview: "",
      rawError: ""
    });
  }
}

const runFinishedAt = new Date().toISOString();
const snapshot = buildSnapshot();
await mkdir(dirname(statusPath), { recursive: true });
await writeFile(statusPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${statusPath} with ${snapshot.summary.completed}/${snapshot.summary.total} completed checks.`);

function integerFromEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function loadEnvFile() {
  try {
    const raw = await readFile(join(rootDir, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsAt = trimmed.indexOf("=");
      if (equalsAt === -1) continue;
      const key = trimmed.slice(0, equalsAt).trim();
      const value = trimmed.slice(equalsAt + 1).trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function loadModels() {
  const raw = await readFile(modelsPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("config/models.json must contain an array.");
  }
  return parsed
    .filter((model) => model && typeof model.id === "string" && model.id.trim())
    .map(normalizeModel);
}

async function loadPreviousStatus() {
  try {
    return JSON.parse(await readFile(statusPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeModel(model) {
  const id = model.id.trim();
  return {
    id,
    name: model.name || titleFromId(id),
    provider: model.provider || providerFromId(id),
    tier: model.tier || "Free Endpoint"
  };
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

async function runWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const workerCount = Math.min(Math.max(concurrency, 1), queue.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await worker(item);
      }
    })
  );
}

async function probeModel(model, inFlightAtStart) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(NVIDIA_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "authorization": `Bearer ${NVIDIA_API_KEY}`,
        "content-type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          {
            role: "system",
            content: "You are an endpoint health probe. Output only the requested tokens. Do not explain."
          },
          {
            role: "user",
            content: "Output exactly the numbers 1 through 16, separated by spaces."
          }
        ],
        temperature: 0,
        max_tokens: PROBE_MAX_TOKENS,
        stream: true
      })
    });

    const contentType = response.headers.get("content-type") || "";

    if (response.status === 202) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const raw = await response.text();
      const parsed = parseBody(raw, contentType);
      return {
        status: "queued",
        message: "Endpoint accepted the request but did not complete immediately.",
        checkedAt,
        latencyMs,
        totalLatencyMs: latencyMs,
        ttftMs: null,
        tokensPerSecond: null,
        outputTokens: null,
        httpStatus: response.status,
        inFlightRequests: 0,
        peakInFlightRequests: inFlightAtStart,
        answerPreview: previewFromResponse(parsed) || "",
        rawError: requestIdFrom(parsed)
      };
    }

    if (!response.ok) {
      const latencyMs = Math.round(performance.now() - startedAt);
      const raw = await response.text();
      const parsed = parseBody(raw, contentType);
      return {
        status: "error",
        message: errorMessageFrom(parsed, raw) || `HTTP ${response.status}`,
        checkedAt,
        latencyMs,
        totalLatencyMs: latencyMs,
        ttftMs: null,
        tokensPerSecond: null,
        outputTokens: null,
        httpStatus: response.status,
        inFlightRequests: 0,
        peakInFlightRequests: inFlightAtStart,
        answerPreview: "",
        rawError: trim(raw, 600)
      };
    }

    const streamResult = contentType.includes("text/event-stream") && response.body
      ? await readStreamingCompletion(response.body, startedAt)
      : await readBufferedCompletion(response, contentType, startedAt);
    const latencyMs = streamResult.totalLatencyMs;
    const outputTokens = streamResult.outputTokens;
    const tokensPerSecond = calculateTokensPerSecond(outputTokens, streamResult.ttftMs, latencyMs);
    const answerPreview = trim(streamResult.content.replace(/\s+/g, " "), 180);

    return {
      status: latencyMs > SLOW_THRESHOLD_MS ? "slow" : "healthy",
      message: latencyMs > SLOW_THRESHOLD_MS ? "Completed, but slower than threshold." : "Completed normally.",
      checkedAt,
      latencyMs,
      totalLatencyMs: latencyMs,
      ttftMs: streamResult.ttftMs,
      tokensPerSecond,
      outputTokens,
      httpStatus: response.status,
      inFlightRequests: 0,
      peakInFlightRequests: inFlightAtStart,
      answerPreview,
      rawError: ""
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const timedOut = error?.name === "AbortError";
    return {
      status: timedOut ? "timeout" : "error",
      message: timedOut ? "Request timed out." : errorMessage(error),
      checkedAt,
      latencyMs,
      totalLatencyMs: latencyMs,
      ttftMs: null,
      tokensPerSecond: null,
      outputTokens: null,
      httpStatus: null,
      inFlightRequests: 0,
      peakInFlightRequests: inFlightAtStart,
      answerPreview: "",
      rawError: timedOut ? "" : errorMessage(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function readStreamingCompletion(body, startedAt) {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let content = "";
  let ttftMs = null;
  let usageOutputTokens = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      for (const data of dataLinesFromEvent(event)) {
        if (data === "[DONE]") continue;

        const parsed = safeJsonParse(data);
        if (!parsed) continue;

        usageOutputTokens = completionTokensFromUsage(parsed) ?? usageOutputTokens;
        const piece = contentFromStreamChunk(parsed);
        if (piece) {
          if (ttftMs === null) ttftMs = Math.round(performance.now() - startedAt);
          content += piece;
        }
      }
    }
  }

  if (buffer) {
    for (const data of dataLinesFromEvent(buffer)) {
      if (data === "[DONE]") continue;
      const parsed = safeJsonParse(data);
      if (!parsed) continue;
      usageOutputTokens = completionTokensFromUsage(parsed) ?? usageOutputTokens;
      const piece = contentFromStreamChunk(parsed);
      if (piece) {
        if (ttftMs === null) ttftMs = Math.round(performance.now() - startedAt);
        content += piece;
      }
    }
  }

  const totalLatencyMs = Math.round(performance.now() - startedAt);
  return {
    content,
    ttftMs,
    totalLatencyMs,
    outputTokens: usageOutputTokens ?? estimateOutputTokens(content)
  };
}

async function readBufferedCompletion(response, contentType, startedAt) {
  const raw = await response.text();
  const parsed = parseBody(raw, contentType);
  const content = previewFromResponse(parsed);
  const latencyMs = Math.round(performance.now() - startedAt);
  return {
    content,
    ttftMs: null,
    totalLatencyMs: latencyMs,
    outputTokens: completionTokensFromUsage(parsed) ?? estimateOutputTokens(content)
  };
}

function dataLinesFromEvent(event) {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function contentFromStreamChunk(parsed) {
  const choice = parsed?.choices?.[0];
  const content =
    choice?.delta?.content ??
    choice?.message?.content ??
    choice?.text ??
    parsed?.output_text ??
    parsed?.text ??
    "";
  return typeof content === "string" ? content : "";
}

function completionTokensFromUsage(parsed) {
  const value =
    parsed?.usage?.completion_tokens ??
    parsed?.usage?.output_tokens ??
    parsed?.usage?.completionTokens ??
    parsed?.usage?.outputTokens;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function estimateOutputTokens(content) {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

function calculateTokensPerSecond(outputTokens, ttftMs, totalLatencyMs) {
  if (!outputTokens || typeof totalLatencyMs !== "number") return null;
  const generationMs = typeof ttftMs === "number" ? totalLatencyMs : totalLatencyMs;
  return Math.round((outputTokens / (generationMs / 1000)) * 10) / 10;
}

function parseBody(raw, contentType) {
  if (!raw || !contentType.includes("json")) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function previewFromResponse(parsed) {
  const content = parsed?.choices?.[0]?.message?.content ?? parsed?.output_text ?? parsed?.text ?? "";
  if (typeof content === "string") return trim(content.replace(/\s+/g, " "), 180);
  return "";
}

function requestIdFrom(parsed) {
  const requestId = parsed?.requestId || parsed?.request_id || parsed?.id || "";
  return requestId ? `requestId: ${requestId}` : "";
}

function errorMessageFrom(parsed, raw) {
  const message =
    parsed?.error?.message ||
    parsed?.detail ||
    parsed?.message ||
    parsed?.title ||
    "";
  if (typeof message === "string" && message) return trim(message, 240);
  return trim(raw, 240);
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return "Unexpected request error.";
}

function trim(value, max) {
  if (!value) return "";
  const stringValue = String(value);
  return stringValue.length > max ? `${stringValue.slice(0, max - 1)}...` : stringValue;
}

function buildSnapshot() {
  const modelRows = models.map((model) => {
    const latest = results.get(model.id);
    const previous = previousById.get(model.id);
    const history = [
      ...(previous?.history || []),
      {
        status: latest.status,
        latencyMs: latest.latencyMs,
        totalLatencyMs: latest.totalLatencyMs ?? latest.latencyMs,
        ttftMs: latest.ttftMs ?? null,
        tokensPerSecond: latest.tokensPerSecond ?? null,
        outputTokens: latest.outputTokens ?? null,
        checkedAt: latest.checkedAt,
        httpStatus: latest.httpStatus
      }
    ].slice(-HISTORY_LIMIT);
    const metrics = metricsFromHistory(history, latest);

    return {
      ...model,
      latest: {
        ...latest,
        peakInFlightRequests,
        metrics
      },
      history,
      metrics,
      consecutiveFailures: countTrailingFailures(history)
    };
  });

  const completed = modelRows.filter((row) =>
    ["healthy", "slow", "queued", "timeout", "error", "not_configured"].includes(row.latest.status)
  );
  const usable = modelRows.filter((row) => ["healthy", "slow"].includes(row.latest.status));
  const healthy = modelRows.filter((row) => row.latest.status === "healthy");
  const down = modelRows.filter((row) => ["queued", "timeout", "error"].includes(row.latest.status));
  const latencies = usable
    .map((row) => row.latest.latencyMs)
    .filter((latency) => typeof latency === "number")
    .sort((a, b) => a - b);

  return {
    configured: Boolean(NVIDIA_API_KEY),
    endpoint: maskEndpoint(NVIDIA_ENDPOINT),
    checking: false,
    generatedAt: runFinishedAt,
    lastRunStartedAt: runStartedAt,
    lastRunFinishedAt: runFinishedAt,
    nextRunAt: new Date(Date.now() + CHECK_INTERVAL_MS).toISOString(),
    checkReason: process.env.GITHUB_ACTIONS ? "github-actions" : "local",
    settings: {
      checkIntervalMs: CHECK_INTERVAL_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      slowThresholdMs: SLOW_THRESHOLD_MS,
      modelConcurrency: MODEL_CONCURRENCY,
      probeMaxTokens: PROBE_MAX_TOKENS,
      historyLimit: HISTORY_LIMIT
    },
    summary: {
      total: modelRows.length,
      completed: completed.length,
      healthy: healthy.length,
      usable: usable.length,
      slow: modelRows.filter((row) => row.latest.status === "slow").length,
      down: down.length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      inFlightRequests,
      peakInFlightRequests
    },
    models: modelRows
  };
}

function metricsFromHistory(history, latest) {
  const latencies = history
    .map((entry) => entry.totalLatencyMs ?? entry.latencyMs)
    .filter((latency) => typeof latency === "number")
    .sort((a, b) => a - b);

  return {
    ttftMs: latest.ttftMs ?? null,
    totalLatencyMs: latest.totalLatencyMs ?? latest.latencyMs ?? null,
    tokensPerSecond: latest.tokensPerSecond ?? null,
    outputTokens: latest.outputTokens ?? null,
    timeoutRate: rateFor(history, (entry) => entry.status === "timeout"),
    http5xxRate: rateFor(history, (entry) => typeof entry.httpStatus === "number" && entry.httpStatus >= 500),
    http429Rate: rateFor(history, (entry) => entry.httpStatus === 429),
    p95LatencyMs: percentile(latencies, 95),
    inFlightRequests: latest.inFlightRequests ?? 0,
    peakInFlightRequests: peakInFlightRequests
  };
}

function rateFor(history, predicate) {
  if (!history.length) return null;
  const matches = history.filter(predicate).length;
  return Math.round((matches / history.length) * 1000) / 10;
}

function countTrailingFailures(history) {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (["healthy", "slow"].includes(history[index].status)) break;
    count += 1;
  }
  return count;
}

function percentile(values, percentileValue) {
  if (values.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * values.length) - 1;
  return values[Math.max(0, Math.min(values.length - 1, index))];
}

function maskEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "custom";
  }
}
