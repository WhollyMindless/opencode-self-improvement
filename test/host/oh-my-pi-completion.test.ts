import { expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { bindCompletion } from "../../src/adapters/oh-my-pi/completion.ts";
import type { OmpContext } from "../../src/adapters/oh-my-pi/context.ts";

function context() {
  const model = buildModel({
    provider: "fixture",
    id: "first",
    baseUrl: "https://first.invalid",
    headers: { "x-route": "original" },
    name: "First",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  });
  const resolved: { model: Model; sessionID?: string }[] = [];
  const ctx: OmpContext = {
    cwd: process.cwd(),
    model,
    sessionManager: { getSessionId: () => "original-session" },
    modelRegistry: {
      resolver: (selected, sessionID) => {
        resolved.push({ model: selected, sessionID });
        return "fake-key";
      },
      find: (provider, id) =>
        provider === "fixture" && id === "override"
          ? { ...model, id }
          : undefined,
    },
  };
  return { ctx, model, resolved };
}

test("built-in completion freezes transcript, routing and credential session before host changes", () => {
  const { ctx, model, resolved } = context();
  const messages = [
    { role: "user", content: [{ type: "text", text: "original" }] },
  ];
  const bound = bindCompletion(ctx, messages)!;
  messages[0].content[0].text = "later";
  model.id = "second";
  model.baseUrl = "https://second.invalid";
  model.headers!["x-route"] = "changed";
  ctx.sessionManager.getSessionId = () => "replacement-session";
  expect(bound.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "original" }] },
  ]);
  expect(bound.model).toEqual({ providerID: "fixture", id: "first" });
  expect(resolved[0]).toMatchObject({
    sessionID: "original-session",
    model: {
      id: "first",
      baseUrl: "https://first.invalid",
      headers: { "x-route": "original" },
    },
  });
});

test("explicit capture models resolve through the host registry without silent fallback", () => {
  const { ctx, resolved } = context();
  expect(bindCompletion(ctx, [], "fixture/override")?.model).toEqual({
    providerID: "fixture",
    id: "override",
  });
  expect(resolved[0].model.id).toBe("override");
  expect(() => bindCompletion(ctx, [], "fixture/missing")).toThrow(
    "unavailable",
  );
  expect(bindCompletion(ctx, [], "invalid")).toBeUndefined();
  expect(resolved).toHaveLength(1);
});

test("missing model capabilities do not attempt credential resolution", () => {
  const { ctx, resolved } = context();
  ctx.model = undefined;
  expect(bindCompletion(ctx, [])).toBeUndefined();
  expect(resolved).toHaveLength(0);
  ctx.modelRegistry = undefined;
  expect(bindCompletion(ctx, [], "fixture/override")).toBeUndefined();
});
