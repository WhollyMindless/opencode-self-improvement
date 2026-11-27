import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
  createAgentSession,
  SessionManager,
  Settings,
  type ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent";

export function openSession(
  cwd: string,
  agentDir: string,
  baseUrl: string,
  options: {
    extensionPath?: string;
    extensions?: ExtensionFactory[];
    persistent?: boolean;
  } = {},
) {
  return createAgentSession({
    cwd,
    agentDir,
    sessionManager: options.persistent
      ? SessionManager.create(cwd, join(agentDir, "sessions"))
      : SessionManager.inMemory(cwd),
    settings: Settings.isolated({
      "models.offline": true,
      "compaction.keepRecentTokens": 0,
      "compaction.autoContinue": false,
    }),
    model: buildModel({
      id: "scripted",
      name: "Scripted",
      provider: "openai",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }),
    getApiKey: async () => "fake-key",
    additionalExtensionPaths: options.extensionPath
      ? [options.extensionPath]
      : [],
    extensions: options.extensions,
    disableExtensionDiscovery: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    noContextFiles: true,
    contextFiles: [],
    skills: [],
    rules: [],
    promptTemplates: [],
    cacheWarming: "off",
    disableModelFallback: true,
    // The shared fake server recognizes this prefix plus tools as an agent turn.
    systemPrompt:
      "You are an AI agent. Use the requested tools. This is an isolated memory integration test.",
  });
}
