// Scripted OpenAI-compatible model server for the terminal merge gate.
//
// opencode talks to this like any openai-compatible provider, so a full real
// turn runs — real host, real plugin, real tool execution — with zero API
// keys. Scenario steps live in <SMOKE_DIR>/steps.json (hot-reloaded per
// request): keys are marker tokens embedded in the user prompt, values are
// arrays of scripted assistant replies ({content?, tool_calls?}) served in
// order per marker. Requests that carry no tools array or look like title
// generation get a canned reply WITHOUT consuming a scenario step.
//
// Control endpoints for the harness:
//   GET  /healthz      -> "ok"
//   GET  /__requests   -> array of logged request bodies for this episode
//   POST /__reset      -> zero per-marker counters, truncate the episode log
import { appendFile, existsSync, readFileSync, truncateSync, writeFileSync } from "node:fs";

const dir = process.env.SMOKE_DIR;
if (!dir) throw new Error("SMOKE_DIR is required");
const stepsFile = `${dir}/steps.json`;
const logFile = `${dir}/requests.jsonl`;
const port = Number(process.env.FAKE_PORT ?? 0);

const counters: Record<string, number> = {};

function sse(responses: unknown[]) {
  const body = responses.map((r) => `data: ${JSON.stringify(r)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function stepFor(body: any): { step: any; served: string } {
  const steps = existsSync(stepsFile) ? JSON.parse(readFileSync(stepsFile, "utf8")) : {};
  const msgs: any[] = body.messages ?? [];
  const first = String(msgs[0]?.content ?? "");
  // Title/aux generation must never consume a scenario step. Agent turns are
  // recognized positively: the real agent system prompt + a tools array.
  // (A /title/i test on the system prompt is NOT a discriminator — the agent
  // prompt itself contains the word "title".)
  const agent =
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    (first.includes("You are an AI agent") || first.includes("OpenCode"));
  const all = JSON.stringify(msgs);
  const marker = agent ? Object.keys(steps).find((m) => all.includes(m)) : undefined;
  if (!marker) return { step: { content: "SMOKE-AUX" }, served: agent ? "agent-no-marker" : "aux" };
  const n = counters[marker] ?? 0;
  counters[marker] = n + 1;
  const arr = steps[marker];
  return { step: arr[Math.min(n, arr.length - 1)], served: `${marker}[${n}]` };
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname === "/__requests") {
      const text = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      return Response.json(text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    }
    if (url.pathname === "/__reset" && req.method === "POST") {
      for (const k of Object.keys(counters)) delete counters[k];
      if (existsSync(logFile)) truncateSync(logFile, 0);
      return new Response("ok");
    }
    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      const body = await req.json();
      appendFile(logFile, JSON.stringify(body) + "\n", () => {});
      const { step, served } = stepFor(body);
      console.log(`served ${served}`);
      const base = {
        id: "chatcmpl-fake",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "scripted",
      };
      const delta: any = { role: "assistant" };
      if (step.content) delta.content = step.content;
      if (step.tool_calls)
        delta.tool_calls = step.tool_calls.map((tc: any, n: number) => ({ index: n, ...tc }));
      return sse([
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: step.tool_calls ? "tool_calls" : "stop" }],
        },
      ]);
    }
    return new Response("not found", { status: 404 });
  },
});
writeFileSync(`${dir}/port`, String(server.port));
console.log(`fake-model listening on ${server.port}`);
