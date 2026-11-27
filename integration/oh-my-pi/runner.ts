// A real SDK session in an isolated child, talking only to the local fake model.
import { join } from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
  createAgentSession,
  SessionManager,
  Settings,
} from "@oh-my-pi/pi-coding-agent";

const [cwd, agentDir, baseUrl, extensionPath, prompt] = process.argv.slice(2);
const { session } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager: SessionManager.inMemory(cwd),
  settings: Settings.isolated({ "models.offline": true }),
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
  additionalExtensionPaths: [extensionPath],
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
try {
  await session.prompt(prompt);
  await Bun.write(
    join(agentDir, "messages.json"),
    JSON.stringify(session.messages),
  );
} finally {
  await session.dispose();
}
