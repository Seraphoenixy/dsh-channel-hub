/**
 * Qoder 的 COSY 协议层：设备身份常量、Encode=1 自定义 base64、请求签名。
 *
 * 从 `index.js` 原样搬出（2026-10-20 模块化），**逻辑零改动**：
 *   · `COSY_*` 常量与 RSA 公钥是硬编码契约（版本号落后会被服务端裁剪目录）
 *   · `qoderEncodeBody` 是 Qoder 自定义 base64（三字母表 + 三段块旋转）
 *   · `buildCosyHeaders` 产出网关平面需要的全套签名头
 *
 * ⚠️ 两个平面的 clientType **不同**（网关 5 / OpenAPI 10），合并会踩坑，
 * 详见各自常量的注释。
 *
 * @module dsh-qoder-connect/cosy
 */
import { createCipheriv, createHash, publicEncrypt, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
const resolveDshHome = () => process.env.DSH_HOME ?? join(homedir(), ".dsh");
//#region COSY 客户端身份常量

/**
 * COSY 内置 RSA 公钥（用来加密临时的 aesKey）。
 * 与 Qoder CLI 同一份；换 key 只会在服务端轮换时发生。
 */
export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * 客户端身份版本号。
 *
 * ⚠️ 这是**硬编码契约**：`Cosy-Version` 落后于 Qoder CLI 当前版本时，服务端会
 * 返回被裁剪过的模型列表（本地实测：CLI 1.1.61 对应 1.1.38 可用）。
 * 随 CLI 升级要复核这里。
 */
export const COSY_VERSION = "1.1.38";
/** OpenAPI 平面用的是另一条版本线。 */
export const COSY_OPENAPI_VERSION = "1.0.1";
/**
 * **网关平面**的 `Cosy-Clienttype`（只给 `buildCosyHeaders` 用）。
 *
 * ⚠️ 它和 OpenAPI 平面的值**不是同一个**，别共用 —— 曾经共用过，正是 2026-09-27
 * 「签到活动读不到」那次误判的根因：两个平面各有各的契约。
 */
export const COSY_CLIENT_TYPE = "5";
/**
 * **OpenAPI 平面**的 `Cosy-ClientType`。
 *
 * App 主包里这是**全局唯一**常量，额度 / dataPolicy / partnerPlan / remoteControl /
 * 签到活动全都用它：
 *
 *   const Mh = Object.freeze({ clientType: 10, businessProduct: "app", sessionType: "app" });
 *   const YR = (t) => ({ …, "Cosy-ClientType": String(Mh.clientType), "User-Agent": "Qoder" });
 *
 * ## 为什么必须写 10
 *
 * `GET /sash/api/v1/me/campaigns`（签到活动）**按客户端类型门控**：用 5 会**稳定**返回
 * `{showCampaign:false, claimable:false, campaigns:[]}`。这个形状与「账号压根没有活动」
 * **完全一样**，于是被误判 —— 2026-09-27 实际踩到：据此把面板改成了"不适用"，
 * 而同一时刻桌面 App 用 10 拿到的是 `claimable:true`、`+100 credits`、`CLAIMABLE`。
 *
 * ## 换成 10 的副作用范围（已逐端点实测）
 *
 * 额度 / 成就 / 积分汇总 / 积分热力 / 活动限额 —— 两档响应**逐字节相同**；
 * 只有「签到活动」不同。验证脚本：`scripts/qoder-openapi-clienttype-compare.mjs`。
 */
export const COSY_OPENAPI_CLIENT_TYPE = "10";
export const COSY_DATA_POLICY = "disagree";

//#endregion
//#region Encode=1（Qoder 自定义 base64）

/** 自定义字母表：第 i 个字符替代标准 base64 的第 i 个字符。 */
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const ENC_TABLE = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) ENC_TABLE[i] = i;
for (let i = 0; i < 64; i += 1) ENC_TABLE[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
// Qoder 用 `$` 代替标准 base64 的 `=`。
ENC_TABLE["=".charCodeAt(0)] = "$".charCodeAt(0);

/**
 * 请求体编码：标准 base64 → 字母表重映射 → 三段块旋转。
 *
 *   标准串 std[0,n)，a = floor(n/3)
 *   密文 = map(std[n-a, n)) + map(std[a, n-a)) + map(std[0, a))
 *
 * 返回 Buffer 直接当请求体用。
 */
export function qoderEncodeBody(plain) {
  const std = Buffer.isBuffer(plain) ? plain.toString("base64") : Buffer.from(plain, "utf8").toString("base64");
  const n = std.length;
  const a = Math.floor(n / 3);
  const out = Buffer.allocUnsafe(n);
  let dst = 0;
  for (let i = n - a; i < n; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = a; i < n - a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  for (let i = 0; i < a; i += 1) out[dst++] = ENC_TABLE[std.charCodeAt(i)];
  return out;
}

//#endregion
//#region COSY 鉴权头

const md5 = (bytes) => createHash("md5").update(bytes).digest("hex");

/**
 * 签名只覆盖 pathname 去掉前导 `/algo`，**不含 query**。
 *
 * 例：`/algo/api/v2/model/list?Encode=1` → `/api/v2/model/list`。
 * 这一点错了会拿到 401 而不是 404，很容易误判成 token 失效。
 */
export function sigPathOf(url) {
  const p = new URL(url).pathname;
  return p.startsWith("/algo") ? p.slice("/algo".length) : p;
}

/** 机器码：优先用 Qoder 已落盘的那份，保证跨次稳定（否则服务端会当成新设备）。 */
export function resolveMachineId() {
  const candidates = [
    process.env.QODERCN_MACHINE_ID,
    join(homedir(), ".qoder-cn", ".auth", "machine_id"),
    join(homedir(), ".qoder", ".auth", "machine_id"),
  ].filter((p) => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    try {
      const value = readFileSync(path, "utf8").trim();
      if (value.length > 0) return value;
    } catch { /* 继续找下一个 */ }
  }
  const fallback = join(resolveDshHome(), "qoder", "machine-id");
  try {
    const value = readFileSync(fallback, "utf8").trim();
    if (value.length > 0) return value;
  } catch { /* 下面生成 */ }
  const generated = randomUUID();
  try {
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, `${generated}\n`, { mode: 0o600 });
  } catch { /* 只读环境就算了，本次进程内仍然一致 */ }
  return generated;
}

/** 平台串。SDK 会按 arch/os 拼，这里照抄。 */
function machineOs() {
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows";
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64_darwin" : "x86_64_darwin";
  return process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
}

/**
 * 生成 `Authorization: Bearer COSY.<payloadB64>.<sig>` 及其配套 `Cosy-*` 头。
 *
 * `body` 必须是**最终要发出去的字节**（即已经过 {@link qoderEncodeBody} 的那份），
 * 因为签名和 `Cosy-Bodyhash` / `Cosy-Bodylength` 都覆盖它。
 */
export function buildCosyHeaders(body, requestUrl, creds) {
  if (typeof creds?.userID !== "string" || creds.userID.length === 0) throw new Error("cosy: userID 为空");
  /**
   * [dsh-connect 2026-09-24 修正] token 的字段名有两套：
   * token-manager 产出的凭据对象用 `jobToken`，而 userinfo 那一步是显式传 `authToken`。
   * 之前只认 `authToken` → 目录刷新每次都抛「cosy: authToken 为空」，
   * 表现成"已登录但模型永远只有兜底那一个"。两者都认即可。
   */
  const authToken = typeof creds?.authToken === "string" && creds.authToken !== "" ? creds.authToken : creds?.jobToken;
  if (typeof authToken !== "string" || authToken.length === 0) throw new Error("cosy: authToken 为空");

  const aesKey = randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: authToken,
    name: creds.name ?? "",
    aid: "",
    email: creds.email ?? "",
  };
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = publicEncrypt(
    { key: QODER_RSA_PUBLIC_KEY, padding: 1 /* RSA_PKCS1_PADDING */ },
    Buffer.from(aesKey),
  ).toString("base64");

  const ts = String(Math.floor(Date.now() / 1000));
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: randomUUID(),
    info: infoB64,
    cosyVersion: COSY_VERSION,
    ideVersion: "",
  })).toString("base64");

  const bodyBytes = body === undefined || body === null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(body) ? body : Buffer.from(body));
  const sig = createHash("md5")
    .update(payloadB64).update("\n")
    .update(cosyKey).update("\n")
    .update(ts).update("\n")
    .update(bodyBytes).update("\n")
    .update(sigPathOf(requestUrl))
    .digest("hex");

  const machineId = creds.machineID ?? resolveMachineId();
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": ts,
    "Cosy-Version": COSY_VERSION,
    "Cosy-Machineid": machineId,
    "Cosy-Machinetoken": machineId,
    "Cosy-Machinetype": "5",
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": COSY_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": md5(bodyBytes),
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPathOf(requestUrl),
    "Cosy-Data-Policy": COSY_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": "v2",
    "X-Request-Id": randomUUID(),
  };
}

//#endregion

