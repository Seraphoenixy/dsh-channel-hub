import { parseQoderRemoteModels } from "../../vendor/ofm/src/qoder-catalog.ts";
import type { QoderFallbackModel } from "../../vendor/ofm/src/qoder-product.ts";

/**
 * Qoder 目录解析：`chat` 与 `app` 两个场景**合并**（按 id 去重，chat 优先）。
 *
 * ## 为什么不能只解析 `chat`（2026-11-08 真实探针实证）
 *
 * QoDuck（key `lmodel`）只在 **`app` 场景**下发：`chat` 12 条、`app` 13 条，
 * 唯一差异就是它；且该条目**没有 `minimal_version`** —— 它从来不是被版本
 * 闸门裁掉的（闸门挡的是 `fast` 等），而是被场景过滤挡住的。实测两场景的
 * 共有 id 内容一致，`app` ⊇ `chat`。
 *
 * ⚠️ 仍按**并集**合并而不是直接取 `app`：场景构成是上游的自由度，未来
 * `chat` 完全可能带 `app` 没有的 cli 专属条目；并集 + 去重对两种方向都稳。
 * 顺序：先 `chat`（既有菜单序），`app` 独有条目按其原序追加在后。
 *
 * 两个场景都解析不出（形状变了）返回 undefined，调用方按「无法识别目录」
 * 处理 —— 与单场景版本的失败语义一致。
 */
export function parseQoderCatalogModels(
  raw: unknown,
): QoderFallbackModel[] | undefined {
  const merged = new Map<string, QoderFallbackModel>();
  for (const scene of ["chat", "app"]) {
    const models = parseQoderRemoteModels(raw, scene);
    if (!models) continue;
    for (const model of models) if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return merged.size > 0 ? [...merged.values()] : undefined;
}
