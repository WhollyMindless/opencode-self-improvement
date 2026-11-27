// Executable opt-in wrapper. Keep the model SDK in the host's dependency tree.
import { randomUUID } from "node:crypto";
import { completeSimple } from "@oh-my-pi/pi-ai";
import {
  buildSessionContext,
  type ExtensionContext,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";
import { createOhMyPiMemory } from "../../src/adapters/oh-my-pi/extension.ts";

export default createOhMyPiMemory<ExtensionContext>({
  capture(ctx) {
    const model = ctx.model;
    if (!model) return undefined;
    const sessionID = ctx.sessionManager.getSessionId();
    const apiKey = ctx.modelRegistry.resolver(model, sessionID);
    const messages = buildSessionContext(
      ctx.sessionManager.getBranch(),
      ctx.sessionManager.getLeafId(),
      undefined,
      { model },
    ).messages;
    return {
      messages,
      model: { providerID: model.provider, id: model.id },
      async generateText(prompt, signal) {
        const answer = await completeSimple(
          model,
          { systemPrompt: [prompt], messages: [], tools: [] },
          {
            apiKey,
            signal,
            sessionId: `memory-capture:${randomUUID()}`,
            maxTokens: 2048,
          },
        );
        if (
          answer.stopReason === "error" ||
          answer.stopReason === "aborted" ||
          answer.content.some((part) => part.type === "toolCall")
        )
          throw new Error("oh-my-pi capture completion failed");
        return answer.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      },
    };
  },
}) satisfies ExtensionFactory;
