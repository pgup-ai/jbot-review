import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { createOpencodeClient } from "@opencode-ai/sdk";

import { REVIEW_PROMPT } from "./prompt.ts";
import type { Finding, ReviewResult, Severity } from "./types.ts";

const HOST = "127.0.0.1";
const PORT = 4096;

type Client = ReturnType<typeof createOpencodeClient>;

/**
 * Spawns `opencode serve` as a local child process and returns an SDK client
 * pointed at it. The server runs with cwd set to the checked-out repository so
 * the agent's file tools operate on the user's code, not the action's directory.
 *
 * @param keyEnv - The env var name opencode expects for this provider's key
 *   (e.g. OPENCODE_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY).
 * @param apiKey - The actual key value.
 */
export function startOpencode(
  cwd: string,
  keyEnv: string,
  apiKey: string,
): { proc: ChildProcess; client: Client } {
  const env = { ...process.env, [keyEnv]: apiKey };
  const proc = spawn("opencode", ["serve", `--hostname=${HOST}`, `--port=${PORT}`], {
    cwd,
    stdio: "inherit",
    env,
  });
  const client = createOpencodeClient({ baseUrl: `http://${HOST}:${PORT}` });
  return { proc, client };
}

/** Polls the server until it accepts requests, or fails after ~12 seconds. */
export async function waitReady(client: Client): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      await client.app.log({
        body: { service: "ai-review", level: "info", message: "ready check" },
      });
      return;
    } catch {
      await sleep(300);
    }
  }
  throw new Error("opencode server did not become ready in time");
}

/**
 * Runs one review session and returns structured findings.
 *
 * The agent runs as the read-only "plan" agent by default, which cannot edit
 * files — this is what keeps the review safe and prevents the non-interactive
 * permission prompts that otherwise hang a CI run.
 *
 * The full repository is checked out and the agent uses its own tools (read,
 * grep, glob, git diff) to explore changes — we only provide the PR context
 * (title, description, changed filenames), not the raw diff.
 *
 * @param guidelines - Repo-level review guidelines discovered from AGENTS.md,
 *   REVIEW.md, and .pr-governance/ (may be empty).
 */
export async function runReview(
  client: Client,
  model: string,
  prContext: string,
  guidelines: string,
): Promise<ReviewResult> {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new Error(`Invalid model "${model}"; expected "provider/model".`);
  }

  const created = await client.session.create();
  const session = created.data;
  if (!session) throw new Error("Failed to create opencode session");

  const promptParts = [REVIEW_PROMPT];
  if (guidelines) {
    promptParts.push("## Repository review guidelines\n", guidelines);
  }
  promptParts.push(prContext);
  const prompt = promptParts.join("\n\n");

  // chat() resolves when the turn completes and returns the assistant message
  // metadata. The text/tool parts are then fetched by message id.
  const chatRes = await client.session.chat({
    path: { id: session.id },
    body: {
      providerID,
      modelID,
      agent: process.env.AGENT || "plan",
      parts: [{ type: "text", text: prompt }],
    },
  });
  const assistant = chatRes.data;
  if (!assistant) throw new Error("opencode chat returned no message");

  const message = await client.session.message({
    path: { id: session.id, messageID: assistant.id },
  });
  const parts = (message.data?.parts ?? []) as ReadonlyArray<{ type: string; text?: string }>;
  // Find the last text part (after any tool calls) — that's the final response.
  const textPart = [...parts].reverse().find((p) => p.type === "text");
  return parseReview(textPart?.text ?? "{}");
}

const VALID_SEVERITIES: ReadonlySet<Severity> = new Set([
  "critical",
  "warning",
  "suggestion",
]);

/** Defensively parse the agent's JSON; malformed output degrades to empty. */
function parseReview(raw: string): ReviewResult {
  let parsed: unknown;
  try {
    // Tolerate stray prose by extracting the outermost JSON object.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    const slice = start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
    parsed = JSON.parse(slice);
  } catch {
    return { summary: "The reviewer returned an unparseable response.", findings: [] };
  }

  const obj = parsed as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];

  const findings: Finding[] = [];
  for (const item of rawFindings) {
    const f = item as Record<string, unknown>;
    if (
      typeof f.path === "string" &&
      typeof f.line === "number" &&
      typeof f.title === "string" &&
      typeof f.body === "string" &&
      typeof f.severity === "string" &&
      VALID_SEVERITIES.has(f.severity as Severity)
    ) {
      findings.push({
        path: f.path,
        line: f.line,
        severity: f.severity as Severity,
        title: f.title,
        body: f.body,
      });
    }
  }
  return { summary, findings };
}
