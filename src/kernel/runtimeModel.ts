// Build the `runtimeModel` object the kernel needs to revive a resumed session,
// from the kernel's own ~/.zcode/cli/config.json. Port of lib.rs
// build_runtime_model. Shape pinned live against the kernel's strict zod schema:
//   { revision, generatedAt, model:{providerId,modelId},
//     provider:{providerId, kind, label?, source, baseURL?,
//               apiKey:{source:"inline", value}?, models:[{modelId,label?}…]} }
// Returns undefined when the config is missing or not in the known layout.

import { Json } from "./protocol";

export function buildRuntimeModel(configJson: string, generatedAt: number): Json | undefined {
  let config: Json;
  try {
    config = JSON.parse(configJson);
  } catch {
    return undefined;
  }

  // model.main is "provider/modelId".
  const main = config?.model?.main;
  if (typeof main !== "string") {
    return undefined;
  }
  const slash = main.indexOf("/");
  if (slash < 0) {
    return undefined;
  }
  const providerId = main.slice(0, slash);
  const modelId = main.slice(slash + 1);

  const provider = config?.provider?.[providerId];
  const kind = provider?.kind;
  if (provider == null || typeof kind !== "string") {
    return undefined;
  }

  const modelsMap = provider.models;
  if (modelsMap == null || typeof modelsMap !== "object" || Array.isArray(modelsMap)) {
    return undefined;
  }
  const models = Object.entries(modelsMap).map(([id, m]: [string, Json]) => ({
    modelId: id,
    label: typeof m?.name === "string" ? m.name : id,
  }));
  if (models.length === 0) {
    return undefined;
  }

  const providerObj: Json = {
    providerId,
    kind,
    label: typeof provider.name === "string" ? provider.name : providerId,
    source: "user",
    models,
  };
  const baseURL = provider?.options?.baseURL;
  if (typeof baseURL === "string") {
    providerObj.baseURL = baseURL;
  }
  const apiKey = provider?.options?.apiKey;
  if (typeof apiKey === "string") {
    // The kernel's credential union; inline carries the key verbatim (same
    // trust domain — the kernel owns config.json to begin with).
    providerObj.apiKey = { source: "inline", value: apiKey };
  }

  return {
    revision: "zcode-vscode-resume",
    generatedAt,
    model: { providerId, modelId },
    provider: providerObj,
  };
}
