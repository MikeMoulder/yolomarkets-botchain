// Server-only model client for paid market insights.
// Gemini is the default low-cost path; OpenRouter remains as fallback.

import "server-only";
import { config as loadEnv } from "dotenv";
import path from "node:path";

if (!process.env.GEMINI_API_KEY && process.env.NODE_ENV !== "production") {
    loadEnv({ path: path.resolve(process.cwd(), "..", ".env"), quiet: true });
}

const SYSTEM = `You are a calibrated prediction-market copilot.
Output STRICT JSON only - no prose before or after. Reason from first principles,
but use the supplied market context as evidence when it is available. Do not
blindly anchor to the market price. When uncertain, lower confidence and reduce
position size, but still choose a side. Your output is consumed programmatically; any
deviation from the schema breaks it.`;

const USER_TEMPLATE = (args: {
    question: string;
    criteria: string;
    deadline: string;
    marketPrice: string;
    context?: string;
}) => `MARKET: "${args.question}"
RESOLUTION CRITERIA: ${args.criteria || "(none provided)"}
RESOLVES: ${args.deadline || "(unknown)"}

CROWD SIGNAL:
  Current market YES price: ${args.marketPrice}%

${args.context ? `MARKET CONTEXT:\n${args.context}\n\n` : ""}ACTION RULES:
  - Recommend buy_yes only when your probability is meaningfully above the
    market YES price after fees/slippage.
  - Recommend buy_no only when your probability is meaningfully below the
    market YES price after fees/slippage.
  - For fast crypto markets, never overstate certainty. If live price context
    is unavailable, set low confidence and prefer smaller size.
  - Keep tips actionable: what to buy/sell, position sizing, and what
    signal would invalidate the trade.

OUTPUT FORMAT (strict JSON, no markdown fences):
{
  "probability": 0.0,
  "confidence": 0.0,
  "action": "buy_yes" | "buy_no",
  "action_label": "Buy YES" | "Buy NO",
  "action_summary": "one sentence telling the user what to do and why",
  "suggested_size": "none" | "small" | "medium",
  "actionable_tips": ["specific next step", "risk control or exit note"],
  "reasoning": "3 to 5 sentences shown to the user",
  "key_sources": ["url1", "url2"],
  "watch_for": ["signal that would change this estimate", "another"],
  "time_sensitivity": "low" | "medium" | "high"
}`;

export type EstimateAction = "buy_yes" | "buy_no";
export type SuggestedSize = "none" | "small" | "medium";

export type Estimate = {
    probability: number;
    confidence: number;
    action: EstimateAction;
    action_label: string;
    action_summary: string;
    suggested_size: SuggestedSize;
    actionable_tips: string[];
    reasoning: string;
    key_sources: string[];
    watch_for: string[];
    time_sensitivity: "low" | "medium" | "high";
};

export function isEstimateProviderConfigured(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY);
}

type EstimateArgs = {
    question: string;
    criteria: string;
    deadline: string;
    marketProb: number; // 0..1
    context?: string;
};

const ESTIMATE_SCHEMA = {
    type: "object",
    properties: {
        probability: { type: "number" },
        confidence: { type: "number" },
        action: { type: "string", enum: ["buy_yes", "buy_no"] },
        action_label: { type: "string", enum: ["Buy YES", "Buy NO"] },
        action_summary: { type: "string" },
        suggested_size: { type: "string", enum: ["none", "small", "medium"] },
        actionable_tips: { type: "array", items: { type: "string" } },
        reasoning: { type: "string" },
        key_sources: { type: "array", items: { type: "string" } },
        watch_for: { type: "array", items: { type: "string" } },
        time_sensitivity: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: [
        "probability",
        "confidence",
        "action",
        "action_label",
        "action_summary",
        "suggested_size",
        "actionable_tips",
        "reasoning",
        "key_sources",
        "watch_for",
        "time_sensitivity",
    ],
};

export async function estimate(args: {
    question: string;
    criteria: string;
    deadline: string;
    marketProb: number; // 0..1
    context?: string;
}): Promise<Estimate | null> {
    // OpenRouter is the primary path (changed 2026-06-19); Gemini is the
    // fallback. `AI_INSIGHT_PROVIDER` can pin one path: "openrouter" disables
    // the Gemini fallback, "gemini" forces the legacy Gemini-only path.
    const provider = (process.env.AI_INSIGHT_PROVIDER ?? "").toLowerCase();
    if (provider !== "gemini") {
        const openRouterEstimate = await estimateWithOpenRouter(args);
        if (openRouterEstimate || provider === "openrouter") return openRouterEstimate;
    }
    return estimateWithGemini(args);
}

async function estimateWithGemini(args: EstimateArgs): Promise<Estimate | null> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const base =
        process.env.GEMINI_BASE_URL ??
        "https://generativelanguage.googleapis.com/v1beta";
    const model =
        process.env.GEMINI_INSIGHT_MODEL ??
        process.env.GEMINI_FREE_MODEL ??
        "gemini-3.1-flash-lite";
    const modelName = model.replace(/^models\//, "");

    const body = geminiRequestBody(
        args,
        process.env.GEMINI_INSIGHT_GOOGLE_SEARCH === "1",
    );

    try {
        const r = await fetch(`${base}/models/${modelName}:generateContent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Number(process.env.AI_INSIGHT_TIMEOUT_MS ?? "20000")),
            next: { revalidate: 300 },
        });
        if (!r.ok) {
            const detail = await safeErrorText(r);
            console.error("[llm/gemini] request failed:", r.status, detail);
            if (body.tools) {
                return estimateWithGeminiNoSearch(args, apiKey, base, modelName);
            }
            return null;
        }

        return parseGeminiEstimate(await r.json(), args.marketProb);
    } catch (e) {
        console.error("[llm/gemini] request error:", safeErrorMessage(e));
        return null;
    }
}

async function estimateWithGeminiNoSearch(
    args: EstimateArgs,
    apiKey: string,
    base: string,
    modelName: string,
): Promise<Estimate | null> {
    try {
        const r = await fetch(`${base}/models/${modelName}:generateContent`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-goog-api-key": apiKey,
            },
            body: JSON.stringify(geminiRequestBody(args, false)),
            signal: AbortSignal.timeout(Number(process.env.AI_INSIGHT_TIMEOUT_MS ?? "20000")),
            next: { revalidate: 300 },
        });
        if (!r.ok) {
            const detail = await safeErrorText(r);
            console.error("[llm/gemini] no-search retry failed:", r.status, detail);
            return null;
        }

        return parseGeminiEstimate(await r.json(), args.marketProb);
    } catch (e) {
        console.error("[llm/gemini] no-search retry error:", safeErrorMessage(e));
        return null;
    }
}

function geminiRequestBody(
    args: EstimateArgs,
    useGoogleSearch: boolean,
): Record<string, unknown> {
    const body: Record<string, unknown> = {
        system_instruction: { parts: [{ text: SYSTEM }] },
        contents: [
            {
                parts: [
                    {
                        text: USER_TEMPLATE({
                            question: args.question,
                            criteria: args.criteria,
                            deadline: args.deadline,
                            marketPrice: (args.marketProb * 100).toFixed(2),
                            context: args.context,
                        }),
                    },
                ],
            },
        ],
        generationConfig: {
            temperature: Number(process.env.GEMINI_INSIGHT_TEMPERATURE ?? "0.15"),
            maxOutputTokens: Number(process.env.AI_INSIGHT_MAX_TOKENS ?? "1200"),
            responseMimeType: "application/json",
            responseSchema: ESTIMATE_SCHEMA,
            thinkingConfig: {
                thinkingLevel:
                    process.env.GEMINI_INSIGHT_THINKING_LEVEL ??
                    process.env.GEMINI_THINKING_LEVEL ??
                    "low",
            },
        },
    };

    if (useGoogleSearch) {
        body.tools = [{ google_search: {} }];
    }

    return body;
}

function parseGeminiEstimate(json: unknown, marketProb: number): Estimate | null {
    const candidate = (json as { candidates?: unknown[] })?.candidates?.[0];
    const parts = (candidate as { content?: { parts?: unknown[] } })?.content?.parts;
    const text = Array.isArray(parts)
        ? parts
              .map((part) => {
                  if (!part || typeof part !== "object") return "";
                  const textPart = part as { text?: unknown };
                  return typeof textPart.text === "string" ? textPart.text : "";
              })
              .join("\n")
              .trim()
        : "";
    if (!text) return null;

    const raw = extractJsonPayload(text);
    if (!raw) return null;
    const parsed = normalizeEstimate(raw, marketProb);
    if (!parsed) return null;

    const groundingSources = extractGeminiSources(candidate);
    if (groundingSources.length > 0) {
        parsed.key_sources = Array.from(
            new Set([...groundingSources, ...(parsed.key_sources ?? [])]),
        );
    }

    return parsed;
}

async function estimateWithOpenRouter(args: EstimateArgs): Promise<Estimate | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const base = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
    const model =
        process.env.OPENROUTER_INSIGHT_MODEL ??
        process.env.OPENROUTER_MODEL ??
        "perplexity/sonar";

    const body = {
        model,
        max_tokens: Number(process.env.AI_INSIGHT_MAX_TOKENS ?? "1200"),
        messages: [
            { role: "system", content: SYSTEM },
            {
                role: "user",
                content: USER_TEMPLATE({
                    question: args.question,
                    criteria: args.criteria,
                    deadline: args.deadline,
                    marketPrice: (args.marketProb * 100).toFixed(2),
                    context: args.context,
                }),
            },
        ],
    };

    try {
        const r = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
                "HTTP-Referer": "https://github.com/yolo-markets",
                "X-Title": "YOLO Markets web",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(Number(process.env.AI_INSIGHT_TIMEOUT_MS ?? "20000")),
            // Server-render-time cache so multiple page hits don't re-bill us.
            next: { revalidate: 300 },
        });
        if (!r.ok) {
            const detail = await safeErrorText(r);
            console.error("[llm/openrouter] request failed:", r.status, detail);
            return null;
        }
        const json = await r.json();
        const message = json?.choices?.[0]?.message;
        const text = message?.content;
        if (typeof text !== "string") return null;
        const raw = extractJsonPayload(text);
        if (!raw) return null;
        const parsed = normalizeEstimate(raw, args.marketProb);
        if (!parsed) return null;

        // Perplexity/online-enabled models return the URLs they actually
        // browsed in a separate field. Merge them so the user sees live
        // citations, not whatever the model imagined for `key_sources`.
        const liveCitations: string[] = [
            ...(Array.isArray(json?.citations) ? (json.citations as unknown[]) : []),
            ...(Array.isArray(message?.annotations)
                ? (message.annotations as Array<{ url?: string; url_citation?: { url?: string } }>)
                      .map((a) => a?.url ?? a?.url_citation?.url)
                : []),
        ].filter((u): u is string => typeof u === "string" && u.length > 0);

        if (liveCitations.length > 0) {
            const merged = new Set<string>([...liveCitations, ...(parsed.key_sources ?? [])]);
            parsed.key_sources = Array.from(merged);
        }

        return parsed;
    } catch (e) {
        console.error("[llm/openrouter] request error:", safeErrorMessage(e));
        return null;
    }
}

async function safeErrorText(r: Response): Promise<string> {
    const text = await r.text().catch(() => "");
    return text.replace(/\s+/g, " ").slice(0, 300);
}

function safeErrorMessage(e: unknown): string {
    return e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
}

function normalizeEstimate(raw: unknown, marketProb: number): Estimate | null {
    if (!raw || typeof raw !== "object") return null;
    const payload = raw as Partial<Estimate>;

    const probability = clamp01(Number(payload.probability));
    const confidence = clamp01(Number(payload.confidence));
    if (probability === null || confidence === null) return null;

    const edge = probability - marketProb;
    const fallbackAction: EstimateAction = edge >= 0 ? "buy_yes" : "buy_no";

    const action = isAction(payload.action) ? payload.action : fallbackAction;
    const action_label =
        typeof payload.action_label === "string" && payload.action_label.trim()
            ? payload.action_label.trim()
            : action === "buy_yes"
              ? "Buy YES"
              : "Buy NO";

    const suggested_size = isSuggestedSize(payload.suggested_size)
        ? payload.suggested_size
        : confidence < 0.45
          ? "none"
          : confidence > 0.7 && Math.abs(edge) > 0.08
            ? "medium"
            : "small";

    return {
        probability,
        confidence,
        action,
        action_label,
        action_summary: cleanString(payload.action_summary) || fallbackActionSummary(action, edge),
        suggested_size,
        actionable_tips: cleanStringArray(payload.actionable_tips),
        reasoning: cleanString(payload.reasoning),
        key_sources: cleanStringArray(payload.key_sources),
        watch_for: cleanStringArray(payload.watch_for),
        time_sensitivity:
            payload.time_sensitivity === "low" ||
            payload.time_sensitivity === "medium" ||
            payload.time_sensitivity === "high"
                ? payload.time_sensitivity
                : "medium",
    };
}

function clamp01(value: number): number | null {
    if (!Number.isFinite(value)) return null;
    return Math.min(1, Math.max(0, value));
}

function cleanString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 6);
}

function extractJsonPayload(text: string): unknown | null {
    const raw = text.trim();
    if (!raw) return null;

    try {
        return JSON.parse(raw);
    } catch {
        // Continue to permissive extraction below.
    }

    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced?.[1]) {
        try {
            return JSON.parse(fenced[1].trim());
        } catch {
            // Continue to object scan below.
        }
    }

    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
        try {
            return JSON.parse(raw.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    return null;
}

function extractGeminiSources(candidate: unknown): string[] {
    if (!candidate || typeof candidate !== "object") return [];
    const grounding = (candidate as { groundingMetadata?: unknown }).groundingMetadata;
    if (!grounding || typeof grounding !== "object") return [];
    const chunks = (grounding as { groundingChunks?: unknown }).groundingChunks;
    if (!Array.isArray(chunks)) return [];

    return chunks
        .map((chunk) => {
            if (!chunk || typeof chunk !== "object") return null;
            const web = (chunk as { web?: unknown }).web;
            if (!web || typeof web !== "object") return null;
            const uri = (web as { uri?: unknown }).uri;
            return typeof uri === "string" && uri.length > 0 ? uri : null;
        })
        .filter((uri): uri is string => Boolean(uri));
}

function isAction(value: unknown): value is EstimateAction {
    return value === "buy_yes" || value === "buy_no";
}

function isSuggestedSize(value: unknown): value is SuggestedSize {
    return value === "none" || value === "small" || value === "medium";
}

function fallbackActionSummary(action: EstimateAction, edge: number): string {
    const edgePts = Math.abs(edge * 100).toFixed(1);
    if (action === "buy_yes") {
        return `Buy YES only if execution stays near the displayed price; estimated edge is about ${edgePts} points.`;
    }
    return `Buy NO only if execution stays near the displayed price; estimated edge is about ${edgePts} points.`;
}
