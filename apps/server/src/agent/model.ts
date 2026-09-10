import { ChatOpenAI } from "@langchain/openai";
import type { AppConfig, ProviderDef } from "../config.js";

export interface BuiltModel {
  llm: ChatOpenAI;
  provider: ProviderDef;
  modelId: string;
}

/**
 * Build an OpenAI-compatible ChatOpenAI instance from the configuration.
 * `baseURL` + `apiKey` make this work with OpenAI, DeepSeek, Moonshot, Ollama,
 * LM Studio, vLLM or any compatible `/v1` endpoint.
 */
export function buildModel(
  config: AppConfig,
  providerId: string | undefined,
  modelId: string | undefined
): BuiltModel {
  const provider =
    config.providers.find((p) => p.id === (providerId ?? config.defaultProvider)) ??
    config.providers[0];
  if (!provider) throw new Error("No provider configured.");

  const model = modelId ?? config.defaultModel ?? provider.models[0]?.id ?? "";
  if (!model) throw new Error("No model configured.");

  if (!provider.apiKey) {
    throw new Error(
      `Provider "${provider.id}" has no API key configured. ` +
        `Set it via the .env file or config/config.local.yaml (apiKey: <your-key>), then restart the server.`
    );
  }

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey ?? "not-required",
    configuration: {
      baseURL: provider.baseURL,
    },
    streaming: true,
  });

  return { llm, provider, modelId: model };
}