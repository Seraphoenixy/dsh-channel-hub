import type { Model } from "../core/types.ts";
// Endpoint/schema reference (not copied implementation):
// https://github.com/darvell/codex-pool/blob/main/antigravity_models.go
// https://github.com/suasgn/openburn/blob/main/docs/providers/antigravity.md
export function parseGeminiCatalog(body: any, supportedId: string): Model[] {
  if (
    !body?.models ||
    typeof body.models !== "object" ||
    Array.isArray(body.models)
  )
    throw Error("Gemini 目录缺少 models 对象");
  const rows = Object.entries(body.models).filter(
    ([id]) =>
      id === supportedId ||
      ["low", "medium", "high", "tiered"].some(
        (t) => id === supportedId + "-" + t,
      ),
  );
  if (!rows.length) return [];
  const exact = rows.find(([id]) => id === supportedId)?.[1] as any;
  const raw = exact ?? (rows[0][1] as any);
  const efforts = rows
    .map(([id]) => id.slice(supportedId.length + 1))
    .filter((t) => ["low", "medium", "high", "tiered"].includes(t));
  const positive = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  return [
    {
      id: supportedId,
      name:
        typeof exact?.displayName === "string"
          ? exact.displayName
          : supportedId,
      contextWindow: positive(raw.inputTokenLimit),
      maxTokens: positive(raw.outputTokenLimit),
      supportsImage: raw.supportsImages === true,
      effortOptions: efforts.length ? efforts : undefined,
      defaultEffort: efforts.includes("medium") ? "medium" : efforts[0],
    },
  ];
}
export async function discoverGemini(options: {
  credential: any;
  headers: Headers;
  endpoints: readonly string[];
  supportedId: string;
  fetcher?: typeof fetch;
}): Promise<Model[]> {
  let failure: unknown;
  for (const endpoint of options.endpoints) {
    try {
      const response = await (options.fetcher ?? fetch)(
        endpoint + "/v1internal:fetchAvailableModels",
        {
          method: "POST",
          headers: options.headers,
          body: JSON.stringify(
            (options.credential.cloudaicompanionProject ??
              options.credential.project)
              ? {
                  project:
                    options.credential.cloudaicompanionProject ??
                    options.credential.project,
                }
              : {},
          ),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw Error("Gemini 目录 HTTP " + response.status);
      return parseGeminiCatalog(await response.json(), options.supportedId);
    } catch (e) {
      failure = e;
    }
  }
  throw failure ?? Error("Gemini 无目录端点");
}
