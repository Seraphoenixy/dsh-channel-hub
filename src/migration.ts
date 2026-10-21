import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { Store } from "./storage/client.ts";

export function convertLegacy(
  provider: string,
  document: any,
):
  | {
      provider: string;
      credential: any;
      expiresAt?: number;
      refreshable: boolean;
    }
  | undefined {
  const c = document?.credential ?? document;
  if (!c || typeof c !== "object") return;
  let credential: any;
  // CodeBuddy CN 与 WorkBuddy 国区是同一产品，统一归入 `buddy`；
  // 仍接受旧的 `workbuddy` 文档，避免历史导出失效。
  if (provider === "buddy" || provider === "workbuddy") {
    if (!c.accessToken && !c.access_token) return;
    provider = provider === "workbuddy" ? "workbuddy" : "buddy";
    credential = {
      access_token: c.access_token ?? c.accessToken,
      refresh_token: c.refresh_token ?? c.refreshToken ?? "",
      expires_at: String(c.expires_at ?? c.expiresAtMs ?? ""),
      domain: c.domain,
      user_id: c.user_id ?? c.uid,
      nickname: c.nickname,
      enterprise_id: c.enterprise_id ?? c.enterpriseId,
      account_type: c.account_type ?? c.accountType,
    };
  } else if (provider === "qoder" || provider === "qodercn") {
    const machine = c.machine_id ?? c.machineID ?? c.machineId;
    if (!(c.token ?? c.access_token) || !c.uid || !machine) return; // No invented device identity for an existing session.
    credential = {
      access_token: c.access_token ?? c.token,
      security_oauth_token: c.security_oauth_token ?? c.token ?? c.access_token,
      refresh_token: c.refresh_token ?? c.refreshToken,
      uid: c.uid,
      machine_id: machine,
      expire_time: c.expire_time ?? c.expiresAt,
      nickname: [c.nickname, c.name, c.username].find(
        (value) => typeof value === "string" && value.trim(),
      )?.trim(),
    };
  } else if (provider.startsWith("trae")) {
    if (!(c.token ?? c.access_token) || !(c.userId ?? c.uid)) return;
    provider = "trae";
    credential = {
      access_token: c.access_token ?? c.token,
      refresh_token: c.refresh_token ?? c.refreshToken ?? "",
      expires_at: c.expires_at ?? c.expiredAt,
      uid: c.uid ?? c.userId,
      nickname: c.account?.username ?? c.nickname,
      // 旧快照没有设备字段时留空（请求头会跳过），不生成新的设备身份。
      machine_id: c.machine_id ?? "",
      device_id: c.device_id ?? c.deviceId ?? "",
    };
  } else return;
  const raw = credential.expire_time ?? credential.expires_at;
  let expiresAt =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : Date.parse(raw ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    expiresAt = undefined as any;
  else if (expiresAt < 1e12) expiresAt *= 1000;
  return {
    provider,
    credential,
    expiresAt,
    refreshable: !!credential.refresh_token,
  };
}
export class MigrationService {
  constructor(
    private home: string,
    private originalCredentials: any,
    private targetCredentials: any,
    private pool: any,
    private store: Store,
    private profile = "desktop",
  ) {}
  private async json(file: string) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return undefined;
    }
  }
  private async candidates() {
    const result: any[] = [];
    const ofm =
      (await this.json(join(this.home, "channel-pack", "state.json"))) ??
      (await this.json(
        join(this.home, "profiles", this.profile, "channel-pack", "state.json"),
      ));
    for (const a of ofm?.accounts ?? [])
      if (typeof a.id === "string" && typeof a.provider === "string")
        result.push({
          source: "ofm",
          id: a.id,
          provider: a.provider,
          nickname: a.nickname,
          ref: a.credentialRef,
          account: a,
          disabled: ofm.disabledModels?.[a.provider] ?? {},
        });
    const registry = await this.json(join(this.home, "connect-channels.json"));
    const defaults = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: "workbuddy" + (i + 1),
        kind: "workbuddy",
        region: i === 3 ? "global" : "cn",
      })),
      { id: "qoder", kind: "qoder", region: "cn" },
      { id: "qoder-global", kind: "qoder", region: "global" },
      { id: "trae", kind: "trae", region: "cn" },
    ];
    const entries = Array.isArray(registry)
      ? registry
      : (registry?.channels ?? registry?.entries ?? defaults);
    const disabledByOld = new Set<string>();
    try {
      const patch = parseYaml(
        await readFile(
          join(this.home, "profiles", this.profile, "cordis.patch.yml"),
          "utf8",
        ),
        { maxAliasCount: 20 },
      );
      const walk = (node: any, selected = false) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const v of node) walk(v, selected);
          return;
        }
        selected =
          selected ||
          node.id === "dsh-connect" ||
          node.name === "dsh-workbuddy-trae-qoder-connect";
        if (selected && Array.isArray(node.disabledModels))
          for (const id of node.disabledModels)
            if (typeof id === "string") disabledByOld.add(id);
        for (const v of Object.values(node)) walk(v, selected);
      };
      walk(patch);
    } catch {
      /* Absent preferences are reported as absent, never fabricated. */
    }
    for (const a of entries) {
      if (typeof a.id !== "string" || !/^[-\w]+$/.test(a.id)) continue;
      const kind = a.kind ?? a.type;
      let provider =
        kind === "workbuddy"
          ? a.region === "global"
            ? "workbuddy"
            : "buddy"
          : kind === "qoder"
            ? a.region === "global"
              ? "qoder"
              : "qodercn"
            : kind === "trae"
              ? "trae"
              : undefined;
      if (!provider) continue;
      const filename =
        kind === "qoder"
          ? provider === "qoder"
            ? "qoder-global-session.json"
            : "qoder-session.json"
          : a.id + ".json";
      const document = await this.json(
        join(this.home, "connect-auth", filename),
      );
      if (!document && !registry) continue;
      const converted = convertLegacy(provider, document);
      provider = converted?.provider ?? provider;
      const oldProvider =
        kind === "qoder" ? (provider === "qoder" ? "qoder2" : "qoder1") : a.id;
      const disabled = Object.fromEntries(
        [...disabledByOld]
          .filter((s) => s.startsWith(oldProvider + "/"))
          .map((s) => [s.slice(oldProvider.length + 1), true]),
      );
      result.push({
        source: "connect",
        id: a.id,
        provider,
        nickname: a.displayName ?? a.name ?? a.id,
        credential: converted?.credential,
        expiresAt: converted?.expiresAt,
        refreshable: converted?.refreshable,
        disabled,
      });
    }
    return result;
  }
  private async resolve(a: any) {
    if (a.credential) return JSON.stringify(a.credential);
    if (!a.ref) return;
    try {
      return (await this.originalCredentials.resolve(a.ref))?.value;
    } catch {
      return undefined;
    }
  }
  async preview() {
    return Promise.all(
      (await this.candidates()).map(async (a) => ({
        source: a.source,
        id: a.id,
        provider: a.provider,
        nickname: a.nickname,
        imported: !!(await this.store.call(
          "get",
          "import:" + a.source + ":" + a.id,
        )),
        requiresLogin: !(await this.resolve(a)),
        hiddenModels: Object.keys(a.disabled).filter((k) => a.disabled[k])
          .length,
      })),
    );
  }
  async importAll(allowed: Set<string>) {
    const report: any[] = [];
    for (const a of await this.candidates()) {
      const key = "import:" + a.source + ":" + a.id;
      if (await this.store.call("get", key)) {
        report.push({ id: a.id, status: "already-imported" });
        continue;
      }
      if (!allowed.has(a.provider)) {
        report.push({ id: a.id, status: "unsupported-product" });
        continue;
      }
      const value = await this.resolve(a);
      if (!value) {
        report.push({ id: a.id, status: "login-required" });
        continue;
      }
      const id =
          "import-" +
          createHash("sha256").update(key).digest("hex").slice(0, 20),
        ref = "ACCOUNT_" + id.replace(/[^A-Za-z0-9_]/g, "_");
      // If a previous import stopped after adding the account, never overwrite credentials on retry.
      if (!this.pool.findAccount(id)) {
        await this.targetCredentials.set(ref, value);
        await this.pool.addAccount({
          ...a.account,
          id,
          provider: a.provider,
          nickname: a.nickname,
          credentialRef: ref,
          enabled: a.account?.enabled ?? true,
          createdAt: a.account?.createdAt ?? Date.now(),
          expiresAt: a.account?.expiresAt ?? a.expiresAt,
          refreshable: a.account?.refreshable ?? a.refreshable ?? false,
        });
      }
      const union = new Set([
        ...this.pool.disabledModelsFor(a.provider),
        ...Object.keys(a.disabled).filter((k) => a.disabled[k]),
      ]);
      await this.pool.setModelsDisabled(a.provider, [...union]);
      await this.store.call("set", key, { id, at: Date.now() });
      report.push({ id: a.id, status: "imported" });
    }
    return report;
  }
}
