import { rateLabel, promotionNote, promotionWindow } from "./core/rate.ts";
import css from "./client.css";

declare const window: Window & { __ModuleLoader__: any };
window.__ModuleLoader__.load({
  id: "dsh-channel-hub",
  factory: (require: any) => {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;
    /* 页面样式见 client.css（esbuild 以 text loader 内联为字符串）。 */

    const fmt = (n: any, d = 0) =>
      typeof n === "number"
        ? n.toLocaleString("zh-CN", { maximumFractionDigits: d })
        : "—";
    const pct = (n: any) =>
      typeof n === "number" ? fmt(n * 100, 1) + "%" : "—";
    /**
     * 把一组分量折算成堆叠柱里各段的像素高度，**并保证每段都看得见**。
     *
     * ⚠️ 真实缺陷（2026-10-21，真实账本实测）：某天 11 个渠道里前三个占了
     * 90%，其余 8 个按纯比例只有 0.1–1.6px —— 渲染出来是一条看不见的细线。
     * 而用户看这张图的目的正是「哪个渠道在消耗」，占比最小的那些恰恰最需要
     * 能看见（否则图上一片空白，只能猜）。
     *
     * 做法：先按比例分配；把低于 `minHeight` 的段抬到下限，缺口从仍有富余的
     * 段里**按富余比例**扣回。于是：
     *  - 总高不变 ⇒ 不同日期的柱子仍然可比；
     *  - 每个非零分量至少有 `minHeight` 像素 ⇒ 不丢信息；
     *  - 大段被轻微压缩，但相对关系不变（这才是可接受的取舍）。
     *
     * 极端情况（柱高本身就放不下所有下限）退化为**等高**：与其让某些段消失，
     * 不如临时放弃比例、保证全部可见。
     *
     * @param values - 各分量原始值（须 ≥ 0）。
     * @param barHeight - 整根柱子的像素高度。
     * @param minHeight - 单段最小可见高度。
     * @returns 与 `values` 等长的高度数组。
     */
    function stackHeights(
      values: number[],
      barHeight: number,
      minHeight: number,
    ): number[] {
      const count = values.length;
      if (count === 0) return [];
      const total = values.reduce((n, v) => n + v, 0);
      if (!(total > 0) || !(barHeight > 0)) return values.map(() => 0);
      // 空间不够放下所有下限：等高，宁可放弃比例也不让段落消失。
      if (barHeight <= minHeight * count)
        return values.map(() => barHeight / count);
      const heights = values.map((v) => (v / total) * barHeight);
      let deficit = 0;
      for (let i = 0; i < count; i++) {
        if (heights[i]! < minHeight) {
          deficit += minHeight - heights[i]!;
          heights[i] = minHeight;
        }
      }
      if (deficit > 0) {
        // 只能从「高于下限」的段里扣，且按各自富余量等比扣，避免压穿下限。
        const room = heights.map((h, i) =>
          values[i]! > 0 && h > minHeight ? h - minHeight : 0,
        );
        const roomTotal = room.reduce((n, v) => n + v, 0);
        if (roomTotal > 0)
          for (let i = 0; i < count; i++)
            if (room[i]! > 0) heights[i]! -= (room[i]! / roomTotal) * deficit;
      }
      return heights;
    }
    const date = (n: any) => (n ? new Date(n).toLocaleString("zh-CN") : "—");
    const mark = (name: any) =>
      String(name ?? "")
        .replace(/[^A-Za-z0-9\u4e00-\u9fff]/g, "")
        .slice(0, 2)
        .toUpperCase() || "?";
    const accents: Record<string, string> = {
      codearts: "#c05a5a",
      buddy: "#2f7cf6",
      workbuddy: "#2fa58a",
      qoder: "#6b6ef5",
      qodercn: "#4c8fd9",
      trae: "#2fa58a",
      loomy: "#d35d8a",
      raccoon: "#b47a2e",
      gemini: "#4285f4",
    };
    const accentOf = (id: string) =>
      accents[id] ??
      ["#5b8def", "#2fa58a", "#d97757", "#8b6be0", "#3a9bd9", "#c05a5a"][
        [...id].reduce((n, ch) => n + ch.charCodeAt(0), 0) % 6
      ];
    const ago = (n: any) => {
      if (!n) return "未更新";
      const delta = Math.max(0, Date.now() - n);
      if (delta < 60000) return "刚刚";
      if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
      if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
      return Math.floor(delta / 86400000) + " 天前";
    };
    const expiryInfo = (n: any) => {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0)
        return { text: "未提供", tone: "" };
      if (n <= Date.now()) return { text: "已过期", tone: "err" };
      if (n - Date.now() < 86400000) return { text: "今日到期", tone: "warn" };
      return { text: date(n), tone: "" };
    };
    /**
     * 把渠道卡按**列数装成满行**，只决定渲染顺序，不动数据。
     *
     * 为什么需要它：2 个以上账号的卡要跨两列（`.chub-channel[data-multi]`），而
     * CSS 网格**不会把跨列卡塞进行尾剩下的那一格** —— 它只能整体换到下一行。
     * 于是只要「单列卡 + 跨列卡」凑不满一行，就会出现一整格空白。用户截图里的
     * `1-2-1` 正是这个：第 1 行 1 张单列卡，第 2 张是跨列卡放不下，被顶到第 2 行，
     * 第 1 行右侧空了一大块。
     *
     * 做法：跨列卡后面**紧跟**足够数量的单列卡把这一行填满。
     *  - `columns = 2`：跨列卡独占一行（后面不跟），剩余单列卡两两成行；
     *  - `columns >= 3`：跨列卡占 2 格，后面跟 `columns - 2` 张单列卡补齐。
     *
     * 只做「行与行之间」的重排，同一类卡内部仍保持宿主顺序。
     *
     * @param list - 宿主返回的渠道数组。
     * @param columns - 网格实测列数（见 `gridColumns`）。
     * @returns 渲染顺序；列数 ≤ 1 或没有跨列卡时原样返回。
     */
    function packChannels(list: any[], columns: number): any[] {
      if (columns <= 1 || list.length <= 1) return list;
      const wide = list.filter((c) => (c.accounts?.length ?? 0) > 1);
      if (wide.length === 0) return list;
      const narrow = list.filter((c) => (c.accounts?.length ?? 0) <= 1);
      // 一张跨列卡之后还能塞下几张单列卡：2 列时 0（它已占满整行）。
      const perWide = Math.max(0, columns - 2);
      const out: any[] = [];
      let cursor = 0;
      for (const card of wide) {
        out.push(card);
        for (let i = 0; i < perWide && cursor < narrow.length; i++)
          out.push(narrow[cursor++]);
      }
      while (cursor < narrow.length) out.push(narrow[cursor++]);
      return out;
    }
    /**
     * 整个渠道中心页面。
     *
     * 唯一入口是宿主的整窗主区域（`main` keyed slot，`width:100%;height:100%`），
     * 故不再需要区分「整窗 / 设置窄页」的布局分支 —— 设置里那份入口已经移除。
     */
    function Page({ ctx }: any) {
      const [tab, setTab] = useState("channels");
      const [channels, setChannels] = useState([] as any[]);
      const [stats, setStats] = useState(null as any);
      const [logs, setLogs] = useState({ items: [], total: 0 } as any);
      const [error, setError] = useState("");
      const [health, setHealth] = useState(null as any);
      const [filter, setFilter] = useState({
        range: "today",
        provider: "",
        accountId: "",
        model: "",
        page: 1,
      });
      const [busy, setBusy] = useState(false);
      const [authorization, setAuthorization] = useState(null as any);
      const [importRows, setImportRows] = useState(null as any);
      /**
       * Loomy 短信登录表单（`{ provider, phone, code, msgid, hint, error }`）。
       *
       * 走页面内表单而不是 `window.prompt`：宿主界面运行在 Electron 渲染进程，
       * 那里的 `prompt()` **没有实现**，调用即抛异常 —— 按钮点下去没有任何反应，
       * 也没有错误提示。手机号/验证码本身不是业务判断，收集后仍交给同一套
       * `login.start`（模式 `sms`），宿主侧协议不变。
       */
      const [smsLogin, setSmsLogin] = useState(null as any);
      /**
       * 渠道网格当前排了几列（`1` 表示单列）。
       *
       * 用途只有一个：把卡片**按实际列数装成满行**（见 `packChannels`）。列数
       * 由容器宽度决定，所以不能用视口宽度猜；这里直接量
       * `grid-template-columns` 解析出轨道数。
       */
      const [gridColumns, setGridColumns] = useState(1);
      const gridRef = useRef(null as any);
      const sequence = useRef(0);
      const loginTimers = useRef(new Set<ReturnType<typeof setInterval>>());
      useEffect(
        () => () => {
          for (const timer of loginTimers.current) clearInterval(timer);
          loginTimers.current.clear();
          sequence.current++;
        },
        [],
      );
      /**
       * 量出渠道网格的真实列数并跟随容器宽度变化。
       *
       * ⚠️ 不能按视口宽度算：宿主的侧栏、页边距都会吃掉宽度，`@container` 断点
       * 也是按**内容区**判的。直接读计算样式的 `grid-template-columns`，把它
       * 解析成轨道数，才是布局真正用的那个数字。
       */
      useEffect(() => {
        const element = gridRef.current;
        if (!element) return;
        const measure = () => {
          const value = getComputedStyle(element).gridTemplateColumns;
          // 单列时 Chromium 给的是像素值（"1156px"），多列才是空格分隔的列表。
          const tracks = value.trim().split(/\s+/).filter(Boolean).length;
          setGridColumns((current: number) => {
            const next = tracks > 0 ? tracks : 1;
            // 只在真的变化时 setState：ResizeObserver 会频繁回调，无条件 set
            // 会把页面打进「测量 → 重渲染 → 再测量」的循环。
            return current === next ? current : next;
          });
        };
        measure();
        /**
         * ⚠️ `measure()` 在首次 effect 里可能读到 `none` 或 0 宽（网格刚挂载、
         * 或宿主还在布局）。ResizeObserver 的首次回调有时**早于**第一次真正
         * 布局，于是列数会一直停在 1，`packChannels` 就整段失效。补一帧再测。
         */
        let frame = 0;
        if (typeof requestAnimationFrame === "function")
          frame = requestAnimationFrame(measure);
        if (typeof ResizeObserver === "undefined") return () => {
          if (frame) cancelAnimationFrame(frame);
        };
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => {
          if (frame) cancelAnimationFrame(frame);
          observer.disconnect();
        };
      }, []);
      const rpc = async (method: string, payload: any = {}) => {
        const result = await ctx.connection.rpc.call("/api", "channel-hub", {
          version: 1,
          method,
          payload,
        });
        if (result?.ok === false)
          throw Error(result.error?.message ?? "请求失败");
        return result.value ?? result;
      };
      const query = () => {
        const day = Date.now() + 8 * 3600000;
        const from = Math.floor(day / 86400000) * 86400000 - 8 * 3600000;
        return {
          provider: filter.provider || undefined,
          accountId: filter.accountId || undefined,
          model: filter.model || undefined,
          from: filter.range === "today" ? from : undefined,
          page: filter.page,
          limit: 30,
        };
      };
      const load = async () => {
        const current = ++sequence.current;
        try {
          const [c, s, l, health] = await Promise.all([
            rpc("channels.list"),
            rpc("usage.summary", query()),
            rpc("requests.list", query()),
            rpc("health"),
          ]);
          if (current !== sequence.current) return true;
          setChannels(c);
          setStats(s);
          setLogs(l);
          setHealth(health);
          setError("");
          return true;
        } catch (e) {
          setError(String(e));
          return false;
        }
      };
      useEffect(() => {
        let active = true;
        // 正常 10 秒一次；失败后退避到 20 / 40 / 60 秒，成功即恢复。
        // 记账故障时不该每 10 秒重打 4 个请求（每个还要等到超时）。
        let delay = 10000;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const schedule = () => {
          clearTimeout(timer);
          timer = setTimeout(tick, delay);
        };
        const tick = async () => {
          if (!active) return;
          if (document.hidden) {
            schedule();
            return;
          }
          const ok = await load();
          delay = ok ? 10000 : Math.min(60000, delay * 2);
          schedule();
        };
        const wake = () => {
          if (!active) return;
          delay = 10000;
          void tick();
        };
        void tick();
        document.addEventListener("visibilitychange", wake);
        return () => {
          active = false;
          sequence.current++;
          clearTimeout(timer);
          document.removeEventListener("visibilitychange", wake);
        };
      }, [
        filter.range,
        filter.provider,
        filter.accountId,
        filter.model,
        filter.page,
      ]);
      const action = async (method: string, payload: any = {}) => {
        setBusy(true);
        try {
          const value = await rpc(method, payload);
          await load();
          return value;
        } catch (e) {
          setError(String(e));
        } finally {
          setBusy(false);
        }
      };
      const login = async (provider: string, mode?: "wechat" | "sms") => {
        setAuthorization(null);
        setError("");
        // 同一渠道同时只保留一条登录路径：发起微信扫码时关掉短信表单，反之亦然。
        setSmsLogin(null);
        if (provider === "loomy" && mode === "sms") {
          // 打开页面内表单（见 `smsLogin` 的说明），不再用 `window.prompt`。
          setSmsLogin({ provider, phone: "", code: "", msgid: "", error: "" });
          return;
        }
        const result = await action("login.start", {
          provider,
          ...(mode ? { mode } : {}),
        });
        if (!result) {
          return;
        }
        if (result.loginUrl) setAuthorization(result);
        if (result.token) {
          let finished = false;
          const timer = setInterval(async () => {
            try {
              const s = await rpc("login.poll", { token: result.token });
              if (s.status === "pending" && s.message)
                setAuthorization((current: any) =>
                  current?.token === result.token
                    ? { ...current, message: s.message }
                    : current,
                );
              if (s.status !== "pending") {
                finished = true;
                clearInterval(timer);
                loginTimers.current.delete(timer);
                setAuthorization((current: any) =>
                  current?.token === result.token ? null : current,
                );
                if (s.error) setError(s.error);
                else if (s.status === "expired")
                  setError("授权会话已失效，请重新发起登录");
                void load();
              }
            } catch (e) {
              finished = true;
              clearInterval(timer);
              loginTimers.current.delete(timer);
              setAuthorization((current: any) =>
                current?.token === result.token ? null : current,
              );
              setError(String(e));
            }
          }, 1500);
          loginTimers.current.add(timer);
          setTimeout(() => {
            clearInterval(timer);
            loginTimers.current.delete(timer);
            if (!finished) {
              finished = true;
              setAuthorization((current: any) =>
                current?.token === result.token ? null : current,
              );
              setError(
                "授权等待超时，请重新发起登录；如网页已成功，请查看账号是否已添加",
              );
            }
          }, 600000);
        }
      };
      /**
       * 短信登录的两个动作。都只调用 `login.start`：
       * - 只带 `phone` + `mode: "sms"` → 宿主下发验证码并返回 `msgid`；
       * - 带 `phone` + `code` + `msgid` → 宿主校验并落库账号。
       *
       * 手机号格式与上游 Loomy 备用路径一致（11 位大陆号码）。在页面内先校验
       * 只是为了不白跑一次请求；宿主侧仍会再校验一次。
       */
      const updateSms = (patch: any) =>
        setSmsLogin((current: any) =>
          current ? { ...current, ...patch } : current,
        );
      const sendSmsCode = async () => {
        const form = smsLogin;
        if (!form) return;
        const phone = String(form.phone ?? "").trim();
        if (!/^1[3-9]\d{9}$/.test(phone)) {
          updateSms({ error: "请输入 11 位手机号（如 13800138000）" });
          return;
        }
        setBusy(true);
        try {
          const result = await rpc("login.start", {
            provider: form.provider,
            phone,
            mode: "sms",
          });
          if (!result?.msgid) throw Error("验证码下发失败，请重试");
          updateSms({
            phone,
            msgid: result.msgid,
            code: "",
            error: "",
            hint: "验证码已发送，请在收到后填写并提交登录。",
          });
        } catch (e) {
          updateSms({ error: String(e) });
        } finally {
          setBusy(false);
        }
      };
      const submitSmsCode = async () => {
        const form = smsLogin;
        if (!form) return;
        if (!form.msgid) {
          updateSms({ error: "请先获取验证码" });
          return;
        }
        const code = String(form.code ?? "").trim();
        if (!/^\d{4,8}$/.test(code)) {
          updateSms({ error: "请输入短信验证码" });
          return;
        }
        setBusy(true);
        try {
          await rpc("login.start", {
            provider: form.provider,
            phone: form.phone,
            code,
            msgid: form.msgid,
            mode: "sms",
          });
          setSmsLogin(null);
          await load();
        } catch (e) {
          // 验证码输错是常见情况：保留已下发的 `msgid`，让用户直接重填，
          // 不强制重新发码（宿主侧同样只在明确过期时才要求重发）。
          updateSms({ error: String(e) });
        } finally {
          setBusy(false);
        }
      };
      /**
       * 一个数据表。
       *
       * @param heads - 表头文字。
       * @param rows - 行数据。
       * @param wide - 允许换行的列下标（长文本列，如「渠道 / 模型」「账号」）。
       *   其余列一律单行：短内容换行只会让行高翻倍、表变得更难读。
       * @param low - 次要列下标：容器窄时整列隐藏，避免出现横向滚动条。
       *   只用于「值在别处也能查到」的列（步数、缓存读/写等，详情 JSON 里都有）。
       *
       * ⚠️ 用**列下标白名单**而不是给每个格子传样式：表格结构保持不变，
       * 只需说明「哪几列是长文本、哪几列可以牺牲」。
       */
      const table = (
        heads: string[],
        rows: any[][],
        wide: number[] = [],
        low?: number[],
      ) => {
        const last = heads.length - 1;
        return h(
          "div",
          { className: "chub-scroll" },
          h(
            "table",
            null,
            h(
              "thead",
              null,
              h(
                "tr",
                null,
                ...heads.map((x, j) =>
                  h(
                    "th",
                    {
                      key: x,
                      ...(low === undefined || !low.includes(j)
                        ? {}
                        : { className: "lowpri" }),
                    },
                    x,
                  ),
                ),
              ),
            ),
            h(
              "tbody",
              null,
              ...rows.map((row, i) =>
                h(
                  "tr",
                  { key: i },
                  ...row.map((v, j) => {
                    // 次要列在窄容器里整列隐藏（见 CSS 的 lowpri 规则）。
                    const classes = [
                      ...(low !== undefined && low.includes(j)
                        ? ["lowpri"]
                        : []),
                      ...(j === last
                        ? []
                        : wide.includes(j)
                          ? ["wide"]
                          : ["nowrap"]),
                    ];
                    return h(
                      "td",
                      {
                        key: j,
                        ...(classes.length === 0
                          ? {}
                          : { className: classes.join(" ") }),
                      },
                      v,
                    );
                  }),
                ),
              ),
            ),
          ),
        );
      };
      /**
       * 运行日志表：**一行一轮**。
       *
       * 一轮 = 同一条用户消息引发的全部模型调用（`logs.items` 由宿主按
       * `turnId` 聚合好）；「步数」列给出该轮调用了几次。
       *
       * ⚠️ **没有「详情」列**（用户 2026-10-21 要求移除）：那一列是逐行的
       * attempts JSON 展开，占掉整张表最宽的位置，实际只在排查时用一次。
       * 移除后错误原因不能随之消失 —— 故改挂到「结果」徽标的 `title` 上：
       * 悬停即见原因，不需要展开、也不再占一列宽度。
       *
       * 「流式速度」与「整块吞吐」是两个口径，分开显示：
       * - 流式速度 = 输出 token /（首字 → 结束），只有观测到首字才有；
       * - 整块吞吐 = 输出 token /（请求开始 → 结束），含首字等待，总是可得。
       * 两者绝不合并成一个平均值。
       */
      const reqTable = (items: any[]) =>
        table(
          [
            "时间",
            "渠道 / 模型",
            "结果",
            "账号",
            "耗时",
            "步数",
            "首字",
            "流式速度",
            "整块吞吐",
            "缓存读 / 写",
            "思考",
            "缓存命中率",
          ],
          items.map((r) => {
            const a = r.attempts?.at(-1),
              m = r.metrics;
            /** 该轮的失败原因（可能来自请求本身或最后一次上游尝试）。 */
            const failure = r.error ?? a?.error;
            return [
              date(r.started),
              r.provider + " / " + r.model,
              h(
                "span",
                {
                  className:
                    "chub-badge " +
                    (r.outcome === "success"
                      ? "ok"
                      : r.outcome === "running" || r.outcome === "cancelled"
                        ? "warn"
                        : "err"),
                  // 详情列移除后，错误原因靠这里悬停可见。
                  ...(failure === undefined || failure === ""
                    ? {}
                    : { title: failure }),
                },
                r.outcome,
              ),
              a?.accountName ?? a?.accountId ?? "—",
              r.ended ? fmt(r.ended - r.started) + " ms" : "运行中",
              r.stepCount ?? 1,
              m?.avgTtftMs !== null ? fmt(m?.avgTtftMs) + " ms" : "—",
              m?.avgTps !== null ? fmt(m?.avgTps, 1) + " tok/s" : "—",
              m?.avgThroughput !== null
                ? fmt(m?.avgThroughput, 1) + " tok/s"
                : "—",
              // ⚠️ 「输入 / 输出」列已移除（用户 2026-10-21）：
              // 那一列的数值在数据看板按渠道 / 模型汇总时更可读，日志表里
              // 每行都重复一遍既占宽又不便横向对比。token 总量仍在看板与
              // 概览小指标里。
              (m?.cacheSamples ? fmt(m.cacheRead) : "—") +
                " / " +
                (m?.cacheWriteSamples ? fmt(m.cacheWrite) : "—"),
              m?.reasoningSamples ? fmt(m.reasoning) : "—",
              pct(m?.cacheHitRate),
            ];
          }),
          // 只有「渠道 / 模型」(1) 与「账号」(3) 可能很长，允许折行；
          // 其余是时间、毫秒、tok/s、token 数这类短内容，保持单行。
          [1, 3],
          /*
           * 窄容器下牺牲的两列：缓存读/写 (9) 与思考 (10)。
           *
           * ⚠️ 下标随列数变化 —— 移除「输入 / 输出」后这两列各前移一位。
           * 写死旧下标会把别的列误藏（上一轮就出现过位置错位的教训）。
           */
          [9, 10],
        );
      const btn = (label: any, onClick: any, opts: any = {}) =>
        h(
          "button",
          {
            type: "button",
            className:
              "chub-btn" +
              (opts.kind ? " " + opts.kind : "") +
              (opts.small ? " small" : ""),
            disabled: opts.disabled ?? busy,
            title: opts.title,
            onClick,
          },
          label,
        );
      const empty = (title: string, text: string) =>
        h(
          "div",
          { className: "chub-empty" },
          h("b", null, title),
          h("p", null, text),
        );
      /**
       * 一个账号的额度读数。
       *
       * 契约：`a.credits` 由宿主算好（`src/core/credits.ts` 的 `creditReading`），
       * 这里的每一句文案都直接来自它 —— **不在这里做业务判断**：
       * - `credits === undefined`：从未查询过，给「未查询」而不是「0」；
       * - `credits.error`：本次没刷上，但如果同时有 `label`，那是上次成功的读数，
       *   两者一起显示（否则一次网络抖动就会让额度看起来没了）；
       * - `progress` 缺失：面值未知，不画进度条（不补 100%）；
       * - 逐包明细里 `active === false` 的包照常列出但置灰，并单独给出
       *   「另有 N 已失效」——服务端仍会返回那部分数字，藏起来等于丢信息。
       */
      /**
       * 包级「什么时候作废 / 什么时候重置」的文案。
       *
       * 优先 `expiresAt`（上游下发的扣费截止或到期时间，Buddy / WorkBuddy /
       * Qoder / Trae 都有）；没有才回落到 `resetAt`（计量周期结束，
       * 只有 Gemini 这类窗口式额度才有意义）。两者同时存在时只显示到期 ——
       * 以 Buddy 为例 `CycleEndTime` 是「每月刷新」，把它当「快作废」会误导。
       *
       * 日期解析失败时原样显示上游字符串，不猜、不显示 Invalid Date。
       */
      const packageWhen = (pkg: any): string | undefined => {
        if (typeof pkg.expiresAt === "string" && pkg.expiresAt.length > 0) {
          const at = Date.parse(pkg.expiresAt);
          return "到期 " + (Number.isFinite(at) ? date(at) : pkg.expiresAt);
        }
        if (typeof pkg.resetAt === "string" && pkg.resetAt.length > 0)
          return "周期至 " + pkg.resetAt;
        return undefined;
      };
      const creditBlock = (a: any, c: any) => {
        const credits = a.credits;
        if (credits === undefined) {
          return h(
            "div",
            { className: "chub-credits" },
            h(
              "div",
              { className: "chub-creditline" },
              h("span", { className: "chub-creditlabel" }, "额度"),
              h(
                "span",
                { className: "muted" },
                c.canBalance === false
                  ? "该渠道不提供额度查询"
                  : "尚未查询，点击“查询额度”读取",
              ),
            ),
          );
        }
        const packages = Array.isArray(credits.packages)
          ? credits.packages
          : [];
        const progress =
          typeof credits.progress === "number" ? credits.progress : undefined;
        return h(
          "div",
          { className: "chub-credits" },
          h(
            "div",
            { className: "chub-creditline" },
            h("span", { className: "chub-creditlabel" }, "额度"),
            credits.label
              ? h(
                  "b",
                  {
                    title: [
                      credits.at ? "读数时间 " + date(credits.at) : "",
                      progress !== undefined
                        ? "剩余 " + pct(progress)
                        : "面值未知，不显示百分比",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                  },
                  credits.label,
                )
              : h(
                  "span",
                  { className: "muted" },
                  credits.unknown ? "无法识别的额度响应" : "未提供读数",
                ),
            ...(credits.tags ?? []).map((tag: string, i: number) =>
              h(
                "span",
                { key: "tag" + i, className: "chub-credittag", title: tag },
                tag,
              ),
            ),
            credits.at && h("span", { className: "muted" }, ago(credits.at)),
            typeof credits.packagesCount === "number" &&
              credits.packagesCount > 1 &&
              h(
                "span",
                { className: "muted" },
                credits.packagesCount + " 个包",
              ),
            typeof credits.expiredTotal === "number" &&
              h(
                "span",
                {
                  className: "muted",
                  title: "已失效包的余额不计入合计（服务端仍会返回）",
                },
                "另有 " + fmt(credits.expiredTotal, 2) + " 已失效",
              ),
          ),
          progress !== undefined &&
            h(
              "div",
              {
                className: "chub-creditbar" + (progress < 0.2 ? " low" : ""),
                role: "progressbar",
                "aria-valuemin": 0,
                "aria-valuemax": 100,
                "aria-valuenow": Math.round(progress * 100),
                title: "剩余 " + pct(progress),
              },
              h("i", { style: { width: pct(progress) } }),
            ),
          credits.note &&
            h("p", { className: "chub-creditnote" }, credits.note),
          credits.error &&
            h(
              "p",
              { className: "chub-creditnote err", title: credits.error },
              credits.label ? "本次刷新失败：" : "",
              credits.error,
            ),
          packages.length > 0 &&
            h(
              "details",
              { className: "chub-fold" },
              h(
                "summary",
                null,
                "额度明细",
                h(
                  "span",
                  { className: "chub-summaryhint" },
                  packages.length + " 项",
                ),
              ),
              h(
                "div",
                { className: "chub-pkgs" },
                ...packages.map((pkg: any, i: number) =>
                  h(
                    "div",
                    {
                      key: "pkg" + i,
                      className: "chub-pkg" + (pkg.active ? "" : " off"),
                      title: [
                        pkg.name,
                        pkg.active ? "有效" : "已失效",
                        pkg.expiresAt
                          ? "到期 " + date(Date.parse(pkg.expiresAt))
                          : "",
                        pkg.resetAt ? "周期至 " + pkg.resetAt : "",
                        pkg.used !== undefined
                          ? "已用 " + fmt(pkg.used, 2)
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" · "),
                    },
                    h(
                      "div",
                      { className: "chub-pkghead" },
                      h("span", { className: "chub-pkgname" }, pkg.name),
                      h(
                        "span",
                        { className: "chub-pkgval" },
                        pkg.active ? "" : "已失效 · ",
                        pkg.label ?? "",
                      ),
                      packageWhen(pkg) &&
                        h(
                          "span",
                          {
                            className: "chub-pkgwhen",
                            title:
                              typeof pkg.expiresAt === "string" &&
                              pkg.expiresAt.length > 0
                                ? "该包的到期时间（过期后额度不可再用）"
                                : "计量周期结束时间",
                          },
                          packageWhen(pkg),
                        ),
                    ),
                    typeof pkg.progress === "number" &&
                      h(
                        "div",
                        {
                          className:
                            "chub-creditbar" +
                            (pkg.progress < 0.2 ? " low" : ""),
                        },
                        h("i", { style: { width: pct(pkg.progress) } }),
                      ),
                  ),
                ),
              ),
            ),
        );
      };
      const pager = () =>
        h(
          "div",
          { className: "chub-pager" },
          h(
            "span",
            null,
            "第 ",
            h("b", null, filter.page),
            " 页 · 共 ",
            h("b", null, logs.total),
            " 条",
          ),
          h(
            "div",
            null,
            btn(
              "上一页",
              () => setFilter({ ...filter, page: filter.page - 1 }),
              {
                small: true,
                disabled: busy || filter.page <= 1,
              },
            ),
            btn(
              "下一页",
              () => setFilter({ ...filter, page: filter.page + 1 }),
              {
                small: true,
                disabled: busy || filter.page * 30 >= logs.total,
              },
            ),
          ),
        );
      const totals = stats?.totals;
      // 轮次 / 步数只在明细保留期内可算（`daily` 日汇总不含轮次），界面上要写明。
      const counts = stats?.counts ?? { turns: 0, steps: 0 };
      const stepsPerTurn = counts.turns
        ? counts.steps / counts.turns
        : undefined;
      const accountTotal = channels.reduce(
        (n: number, c: any) => n + (c.accounts?.length ?? 0),
        0,
      );
      const enabledTotal = channels.reduce(
        (n: number, c: any) =>
          n + (c.accounts?.filter((a: any) => a.enabled).length ?? 0),
        0,
      );
      const modelIds = new Set<string>();
      for (const c of channels)
        for (const a of c.accounts ?? [])
          for (const m of a.catalog?.models ?? []) modelIds.add(m.id);
      const failedChannels = channels.filter((c: any) => c.error).length;
      /**
       * 渠道卡的**渲染顺序**：由 `packChannels` 按实际列数装箱决定。
       *
       * ⚠️ 这是布局的一部分，不是化妆：2 个以上账号的卡跨两列，而 CSS 网格
       * **不会把它塞进行尾剩下的那一格**，只能整体换行 —— 于是「单列卡 + 跨列卡」
       * 凑不满一行时，前一行右侧就空一整格（用户截图里的 `1-2-1`：华为码道
       * 独占第 1 行，跨列的 CodeBuddy 被顶到第 2 行）。
       *
       * ⚠️ 必须**真的重排 DOM 顺序**，不能用 CSS `order` 或
       * `grid-auto-flow:dense`：那两者让视觉顺序偏离 DOM 顺序，Tab 焦点、
       * 读屏顺序、`Ctrl+F` 的阅读路径都会与实际位置错位（`dense` 实测还会把
       * 后面的单列卡提到跨列卡前面，顺序更乱）。
       */
      const orderedChannels = packChannels(channels, gridColumns);
      const series = stats?.series ?? [];
      /**
       * 每日 × 渠道的交叉数据（宿主在 `stats.dailyByProvider` 给出）。
       *
       * ⚠️ 用户 2026-10-21 要求「每日 token 消耗按来源分别统计绘制」：
       * 旧的 `series` 把所有渠道混成一根柱子，看不出是哪家吃掉了额度。
       * 这里把它折成 `day → [{ provider, tokens }]`，用于画**堆叠柱**。
       */
      const dailyByProvider: any[] = Array.isArray(stats?.dailyByProvider)
        ? stats.dailyByProvider
        : [];
      /**
       * 渠道 → 颜色。
       *
       * 顺序取「该渠道在整个区间内的 Token 总量降序」，保证：
       *  - 量大的渠道排在堆叠底部，视觉上更稳；
       *  - 同一个渠道在每根柱子里颜色一致；
       *  - 顺序不随日期或查询顺序抖动。
       * 色板用固定序列循环，渠道多于色板时重复，但**相邻不会撞色**。
       */
      const providerTotals = new Map<string, number>();
      for (const row of dailyByProvider)
        providerTotals.set(
          String(row.provider),
          (providerTotals.get(String(row.provider)) ?? 0) +
            (typeof row.totalTokens === "number" ? row.totalTokens : 0),
        );
      const dailyProviders: string[] = [...providerTotals.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([provider]) => provider);
      /**
       * 整个筛选区间的 Token 合计。
       *
       * ⚠️ 从 `dailyByProvider` 求和而不是另取一个字段：图例的各项之和必须
       * 与「合计」逐字相等，否则用户按图例相加会对不上（实测两者与 KPI 的
       * `totals.totalTokens` 完全一致）。
       */
      const dailyTotalTokens = [...providerTotals.values()].reduce(
        (n, v) => n + v,
        0,
      );
      const segmentColors = [
        "#5785dd",
        "#2f9e6b",
        "#d6922f",
        "#b47a2e",
        "#d97757",
        "#8b6be0",
        "#4c8fd9",
        "#2fa58a",
        "#d35d8a",
        "#6b6ef5",
        "#c05a5a",
        "#3a9bd9",
      ];
      const colorOfProvider = (provider: string) => {
        const index = dailyProviders.indexOf(provider);
        return segmentColors[(index < 0 ? 0 : index) % segmentColors.length];
      };
      /** 每天的各渠道分量（只保留 > 0 的，避免空段）。 */
      const daySegments = (dayId: string) =>
        dailyByProvider
          .filter((row) => String(row.day) === dayId)
          .map((row) => ({
            provider: String(row.provider),
            tokens: typeof row.totalTokens === "number" ? row.totalTokens : 0,
          }))
          .filter((segment) => segment.tokens > 0);
      const maxTokens = Math.max(
        1,
        ...series.map((d: any) =>
          typeof d.totalTokens === "number" ? d.totalTokens : 0,
        ),
      );
      return h(
        "main",
        // 铺满宿主主区域并自带纵向滚动（见 `.chub` 的 `height:100%` 与
        // `overflow-y:auto`）。这里不再有第二种布局形态。
        { className: "chub" },
        h("style", null, css),
        h(
          "header",
          { className: "chub-hero" },
          h(
            "div",
            { className: "chub-pagehead" },
            h(
              "div",
              { className: "chub-headline" },
              h("span", { className: "chub-eyebrow" }, "Channel Hub · DSH"),
              h("h2", null, "渠道中心"),
              h(
                "p",
                { className: "chub-sub" },
                "统一管理渠道账号、动态模型目录与真实请求用量。账号、目录和记录均留在本机。",
              ),
            ),
            h(
              "div",
              { className: "chub-pills" },
              h(
                "span",
                {
                  className:
                    "chub-pill " +
                    (health?.failedWrites > 0 ? "err" : health ? "ok" : ""),
                },
                h("span", { className: "chub-dot" }),
                health
                  ? health.failedWrites > 0
                    ? "记录异常"
                    : "记录正常"
                  : "检查中",
              ),
              h(
                "span",
                { className: "chub-pill" },
                "渠道 ",
                channels.length || "—",
              ),
              h("span", { className: "chub-pill" }, "账号 ", accountTotal),
            ),
          ),
          h(
            "div",
            { className: "chub-ministats" },
            ...[
              [
                "渠道",
                channels.length ? String(channels.length) : "—",
                failedChannels ? failedChannels + " 个异常" : "全部正常",
              ],
              ["账号", String(accountTotal), enabledTotal + " 个启用"],
              ["动态模型", String(modelIds.size), "来自远端目录"],
              [
                "尝试",
                fmt(totals?.attempts),
                filter.range === "today" ? "今日" : "全部",
              ],
            ].map(([label, value, sub]) =>
              h(
                "div",
                { className: "chub-mini", key: label },
                h("span", null, label),
                h("b", null, value),
                h("i", null, sub),
              ),
            ),
          ),
        ),
        h(
          "div",
          { className: "chub-navbar" },
          h(
            "nav",
            { className: "chub-tabs", "aria-label": "渠道中心页面" },
            ...[
              ["channels", "渠道", channels.length],
              ["dashboard", "数据看板", 0],
              ["logs", "运行日志", logs.total],
            ].map(([id, title, count]: any) =>
              h(
                "button",
                {
                  key: id,
                  type: "button",
                  "aria-current": tab === id ? "page" : undefined,
                  onClick: () => setTab(id),
                },
                title,
                count > 0 &&
                  h("span", { className: "chub-tabcount" }, fmt(count)),
              ),
            ),
          ),
          h(
            "div",
            { className: "chub-navacts" },
            h(
              "span",
              { className: "chub-hint" },
              "每 10 秒自动刷新（失败后退避）",
            ),
            btn("刷新", load, { kind: "ghost", disabled: busy }),
          ),
        ),
        error &&
          h(
            "div",
            { className: "chub-alert err", role: "alert" },
            h("b", null, "操作未完成"),
            h("p", null, error),
          ),
        authorization &&
          h(
            "div",
            { className: "chub-alert info", role: "status" },
            h(
              "b",
              null,
              authorization.browserOpened
                ? "已调用默认浏览器打开授权页"
                : "未能自动打开浏览器",
            ),
            h(
              "p",
              null,
              authorization.browserOpened
                ? "完成登录后此页面会自动刷新。"
                : "请点击下方链接继续授权。",
              authorization.userCode && " 设备授权码：",
              authorization.userCode && h("code", null, authorization.userCode),
              authorization.userCode && "，若页面未自动填入请手动输入。",
            ),
            authorization.message && h("p", null, authorization.message),
            h(
              "a",
              {
                href: authorization.loginUrl,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              "打开授权页面",
            ),
          ),
        health?.failedWrites > 0 &&
          h(
            "div",
            { className: "chub-alert err" },
            h("b", null, "本地记录写入异常 " + health.failedWrites + " 次"),
            h("p", null, health.lastError),
          ),
        tab !== "channels" &&
          h(
            "div",
            { className: "chub-filters" },
            h(
              "div",
              { className: "chub-filterhead" },
              h("b", null, "筛选"),
              h(
                "span",
                null,
                filter.range === "today" ? "今日数据" : "全部数据",
              ),
            ),
            h(
              "div",
              { className: "chub-filterrow" },
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "时间范围"),
                h(
                  "select",
                  {
                    value: filter.range,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        range: e.target.value,
                        page: 1,
                      }),
                  },
                  h("option", { value: "today" }, "今日"),
                  h("option", { value: "all" }, "全部"),
                ),
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "渠道"),
                h(
                  "select",
                  {
                    value: filter.provider,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        provider: e.target.value,
                        accountId: "",
                        page: 1,
                      }),
                  },
                  h("option", { value: "" }, "全部渠道"),
                  ...channels.map((c: any) =>
                    h("option", { key: c.id, value: c.id }, c.name),
                  ),
                ),
              ),
              h(
                "label",
                { className: "chub-field" },
                h("span", null, "账号"),
                h(
                  "select",
                  {
                    value: filter.accountId,
                    onChange: (e: any) =>
                      setFilter({
                        ...filter,
                        accountId: e.target.value,
                        page: 1,
                      }),
                  },
                  h("option", { value: "" }, "全部账号"),
                  ...channels
                    .filter(
                      (c: any) => !filter.provider || c.id === filter.provider,
                    )
                    .flatMap((c: any) =>
                      c.accounts.map((a: any) =>
                        h(
                          "option",
                          { key: a.id, value: a.id },
                          a.nickname ?? a.id,
                        ),
                      ),
                    ),
                ),
              ),
              h(
                "label",
                { className: "chub-field grow" },
                h("span", null, "模型 ID"),
                h("input", {
                  placeholder: "按模型 ID 筛选",
                  value: filter.model,
                  onChange: (e: any) =>
                    setFilter({ ...filter, model: e.target.value, page: 1 }),
                }),
              ),
            ),
          ),
        tab === "channels" &&
          h(
            "div",
            { className: "chub-body" },
            h(
              "section",
              { className: "chub-section" },
              h(
                "div",
                { className: "chub-sectionhead" },
                h(
                  "div",
                  null,
                  h("h3", null, "全部渠道"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "自动签到并更新状态；额度每 5 分钟更新；每小时检查凭据，到期前 3 天续期。",
                  ),
                ),
                h(
                  "div",
                  { className: "chub-sectools" },
                  btn(
                    "旧账号导入",
                    async () =>
                      setImportRows(await action("migration.preview")),
                    { kind: "ghost", small: true },
                  ),
                ),
              ),
              importRows &&
                h(
                  "div",
                  { className: "chub-panel chub-migration" },
                  h(
                    "div",
                    { className: "chub-panelhead" },
                    h(
                      "div",
                      null,
                      h("h4", null, "旧账号迁移预览"),
                      h(
                        "p",
                        null,
                        "仅导入旧项目中的账号与模型偏好；重复导入不会覆盖现有登录。",
                      ),
                    ),
                  ),
                  table(
                    ["来源", "账号", "渠道", "状态", "隐藏模型"],
                    importRows.map((row: any) => [
                      row.source ?? "导入结果",
                      row.nickname ?? row.id,
                      row.provider ?? "—",
                      row.status ??
                        (row.imported
                          ? "已导入"
                          : row.requiresLogin
                            ? "需要重新登录"
                            : "可导入"),
                      fmt(row.hiddenModels),
                    ]),
                    // 「来源」与「账号」可能是长路径/长昵称。
                    [0, 1],
                  ),
                  h(
                    "div",
                    { className: "chub-panelacts" },
                    btn(
                      "确认导入账号及模型偏好",
                      async () =>
                        setImportRows(
                          await action("migration.import", { confirm: true }),
                        ),
                      { kind: "primary", small: true },
                    ),
                    btn("收起", () => setImportRows(null), {
                      kind: "ghost",
                      small: true,
                    }),
                  ),
                ),
              h(
                "div",
                { className: "chub-channels", ref: gridRef },
                ...orderedChannels.map((c: any) => {
                  const accounts = c.accounts ?? [];
                  const catalogModels = new Set<string>();
                  for (const a of accounts.filter(
                    (a: any) =>
                      a.enabled &&
                      (!c.selectedAccountId || a.id === c.selectedAccountId),
                  ))
                    for (const m of a.catalog?.models ?? [])
                      catalogModels.add(m.id);
                  const latest = Math.max(
                    0,
                    ...accounts.map((a: any) => a.catalog?.updated ?? 0),
                  );
                  const stale = accounts.filter(
                    (a: any) => a.catalog?.stale,
                  ).length;
                  const state = c.error
                    ? "err"
                    : accounts.length === 0
                      ? "idle"
                      : accounts.some((a: any) => a.enabled)
                        ? "on"
                        : "off";
                  return h(
                    "article",
                    {
                      key: c.id,
                      className: "chub-channel",
                      "data-state": state,
                      /**
                       * 2 个以上账号的卡片跨两列（样式见 client.css 的
                       * `.chub-channel[data-multi]`）。
                       *
                       * 账号块是纵向列表，多一个账号就多一整块，于是「双账号
                       * 卡」比「单账号卡」高约 200px；网格按行对齐，同排的
                       * 单账号卡下面就是一块死白（1440px 实测 634px）。跨列后
                       * 账号在卡内并排，高度差被宽度吸收。
                       *
                       * ⚠️ 用显式属性而不是让 CSS 写 `:has(.chub-acct +
                       * .chub-acct)`：那会把布局分支绑在标记结构上 —— 账号
                       * 列表里插入任何兄弟元素（错误提示、分组标题、滚动容器）
                       * 都会让 `+` 失效，卡片静默退回单列。
                       */
                      "data-multi": accounts.length > 1 ? "" : undefined,
                      style: { "--chan-accent": accentOf(c.id) } as any,
                    },
                    h(
                      "div",
                      { className: "chub-chanhead" },
                      h("span", { className: "chub-chanlogo" }, mark(c.name)),
                      h(
                        "div",
                        { className: "chub-chanid" },
                        h("b", { title: c.name }, c.name),
                        h(
                          "span",
                          null,
                          c.id,
                          " · ",
                          accounts.length,
                          " 个账号",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-chanstate" },
                        c.error
                          ? "渠道异常"
                          : accounts.length === 0
                            ? "未接入"
                            : accounts.some((a: any) => a.enabled)
                              ? "运行中"
                              : "已停用",
                      ),
                    ),
                    c.error &&
                      h("p", { className: "chub-inline err" }, c.error),
                    /**
                     * 统计与操作合并在同一行：操作按钮靠右（`margin-left:auto`）。
                     *
                     * ⚠️ 别把 `.chub-chanacts` 再拆成独立一行 —— 卡片头部信息已经
                     * 三行（标题 / 状态、统计、账号列表），按钮单独占一行会让
                     * 每张卡在常见宽度下多出 30px 空白。窄到放不下时 flex-wrap
                     * 会把按钮换到下一行，`margin-left:auto` 仍然靠右。
                     */
                    h(
                      "div",
                      { className: "chub-chanmeta" },
                      h(
                        "label",
                        { className: "chub-account-choice" },
                        h("span", null, "使用账号"),
                        h(
                          "select",
                          {
                            "aria-label": c.name + " 使用账号",
                            value: c.selectedAccountId ?? "",
                            disabled: busy,
                            title:
                              "对该渠道后续请求生效；指定账号时不会自动换号",
                            onChange: (e: any) =>
                              action("channels.selectAccount", {
                                provider: c.id,
                                accountId: e.target.value || null,
                              }),
                          },
                          h("option", { value: "" }, "自动选择"),
                          c.selectedAccountId &&
                            !accounts.some(
                              (a: any) => a.id === c.selectedAccountId,
                            ) &&
                            h(
                              "option",
                              { value: c.selectedAccountId, disabled: true },
                              "指定账号已删除，请重新选择",
                            ),
                          ...accounts.map((a: any) =>
                            h(
                              "option",
                              {
                                key: a.id,
                                value: a.id,
                                disabled: !a.enabled,
                              },
                              (a.nickname || a.id) +
                                (a.nickname &&
                                accounts.filter(
                                  (other: any) => other.nickname === a.nickname,
                                ).length > 1
                                  ? " · " + a.id.slice(-6)
                                  : "") +
                                (a.enabled ? "" : "（已停用）"),
                            ),
                          ),
                        ),
                        c.selectedAccountId &&
                          h(
                            "span",
                            { className: "muted" },
                            "固定使用，不自动换号",
                          ),
                      ),
                      h(
                        "span",
                        null,
                        "账号 ",
                        h(
                          "b",
                          null,
                          accounts.filter((a: any) => a.enabled).length +
                            "/" +
                            accounts.length,
                        ),
                      ),
                      h(
                        "span",
                        null,
                        "模型 ",
                        h(
                          "b",
                          null,
                          catalogModels.size ? String(catalogModels.size) : "—",
                        ),
                      ),
                      h(
                        "span",
                        {
                          className: stale ? "warn" : "",
                          title: latest ? date(latest) : "",
                        },
                        stale
                          ? "目录 · " + stale + " 个账号过期"
                          : latest
                            ? "目录 · " + ago(latest)
                            : "目录未更新",
                      ),
                      h(
                        "div",
                        { className: "chub-chanacts" },
                        c.id === "loomy"
                          ? h(
                              React.Fragment,
                              null,
                              btn("微信扫码登录", () => login(c.id, "wechat"), {
                                kind: "primary",
                                small: true,
                                disabled:
                                  busy || !!c.error || c.canLogin === false,
                              }),
                              btn("短信登录", () => login(c.id, "sms"), {
                                small: true,
                                disabled:
                                  busy || !!c.error || c.canLogin === false,
                              }),
                            )
                          : btn("添加账号", () => login(c.id), {
                              kind: "primary",
                              small: true,
                              disabled:
                                busy || !!c.error || c.canLogin === false,
                            }),
                        btn(
                          "更新模型",
                          () => action("models.refresh", { provider: c.id }),
                          { small: true },
                        ),
                      ),
                    ),
                    smsLogin?.provider === c.id &&
                      h(
                        "div",
                        { className: "chub-smsform" },
                        h(
                          "div",
                          { className: "chub-smsfields" },
                          h(
                            "label",
                            { className: "chub-field" },
                            h("span", null, "手机号"),
                            h("input", {
                              type: "tel",
                              inputMode: "numeric",
                              autoComplete: "tel",
                              value: smsLogin.phone,
                              placeholder: "11 位手机号",
                              disabled: busy,
                              onChange: (e: any) =>
                                updateSms({ phone: e.target.value, error: "" }),
                            }),
                          ),
                          h(
                            "label",
                            { className: "chub-field" },
                            h("span", null, "短信验证码"),
                            h("input", {
                              type: "text",
                              inputMode: "numeric",
                              autoComplete: "one-time-code",
                              value: smsLogin.code,
                              placeholder: "收到后填写",
                              disabled: busy || !smsLogin.msgid,
                              onChange: (e: any) =>
                                updateSms({ code: e.target.value, error: "" }),
                            }),
                          ),
                        ),
                        smsLogin.hint &&
                          h(
                            "p",
                            { className: "chub-inline muted" },
                            smsLogin.hint,
                          ),
                        smsLogin.error &&
                          h(
                            "p",
                            { className: "chub-inline err" },
                            smsLogin.error,
                          ),
                        h(
                          "div",
                          { className: "chub-chanacts" },
                          btn("获取验证码", sendSmsCode, {
                            small: true,
                            disabled: busy,
                          }),
                          btn("提交登录", submitSmsCode, {
                            kind: "primary",
                            small: true,
                            disabled: busy || !smsLogin.msgid,
                          }),
                          btn("取消", () => setSmsLogin(null), {
                            small: true,
                            disabled: busy,
                          }),
                        ),
                      ),
                    accounts.length === 0
                      ? c.canLogin === false
                        ? empty(
                            "IDE 凭据接入",
                            "此产品使用 IDE 导出凭据，请通过“旧账号导入”接入。",
                          )
                        : empty(
                            "尚未添加账号",
                            "登录后会在此显示账号状态与动态目录。",
                          )
                      : h(
                          "div",
                          { className: "chub-acctlist" },
                          ...accounts.map((a: any) => {
                            const cat = a.catalog ?? {};
                            const models = cat.models ?? [];
                            const disabledModels = cat.disabled ?? [];
                            const allModelsOff =
                              models.length > 0 &&
                              models.every((m: any) =>
                                disabledModels.includes(m.id),
                              );
                            const exp = expiryInfo(a.expiresAt);
                            return h(
                              "section",
                              { key: a.id, className: "chub-acct" },
                              h(
                                "div",
                                { className: "chub-accthead" },
                                h(
                                  "span",
                                  { className: "chub-avatar" },
                                  mark(a.nickname || a.id),
                                ),
                                h(
                                  "div",
                                  { className: "chub-acctid" },
                                  h(
                                    "b",
                                    { title: a.nickname },
                                    a.nickname || "未命名账号",
                                  ),
                                  h(
                                    "span",
                                    null,
                                    "到期 ",
                                    h("i", { className: exp.tone }, exp.text),
                                  ),
                                ),
                                h(
                                  "div",
                                  { className: "chub-acctbadges" },
                                  h(
                                    "span",
                                    {
                                      className:
                                        "chub-badge " +
                                        (a.enabled ? "ok" : "off"),
                                    },
                                    a.enabled ? "启用" : "停用",
                                  ),
                                  a.renewal?.refreshing &&
                                    h(
                                      "span",
                                      { className: "chub-badge warn" },
                                      "续期中",
                                    ),
                                  a.renewal?.error &&
                                    h(
                                      "span",
                                      {
                                        className: "chub-badge err",
                                        title: a.renewal.error,
                                      },
                                      "续期失败",
                                    ),
                                ),
                              ),
                              a.renewal?.error &&
                                h(
                                  "p",
                                  { className: "chub-inline err" },
                                  "自动续期失败：",
                                  a.renewal.error,
                                ),
                              h(
                                "div",
                                { className: "chub-acctmeta" },
                                h(
                                  "span",
                                  null,
                                  "目录 ",
                                  cat.updated ? ago(cat.updated) : "未更新",
                                ),
                                h(
                                  "span",
                                  null,
                                  "模型 ",
                                  h("b", null, fmt(models.length)),
                                ),
                                cat.stale &&
                                  h(
                                    "span",
                                    { className: "warn" },
                                    "缓存已过期",
                                  ),
                                cat.error &&
                                  h(
                                    "span",
                                    { className: "err", title: cat.error },
                                    "目录异常",
                                  ),
                              ),
                              cat.error &&
                                h(
                                  "p",
                                  { className: "chub-inline err" },
                                  cat.error,
                                ),
                              // 额度：读数、进度与逐包明细都由宿主拼好
                              // （src/core/credits.ts）。浏览器只排版，不判断
                              // 「0 / 查不到 / 多单位」—— 那三件事在两端各写一遍
                              // 必然漂移（参考项目的 `creditsOf` 同理）。
                              creditBlock(a, c),
                              h(
                                "div",
                                {
                                  className: "chub-inline",
                                  title: a.checkin?.message,
                                },
                                h("b", null, "签到："),
                                a.checkin?.label ??
                                  (c.canClaim
                                    ? "等待自动签到"
                                    : "不支持自动签到"),
                                a.checkin?.message &&
                                  h(
                                    "span",
                                    {
                                      className:
                                        a.checkin.state === "failed"
                                          ? "err"
                                          : "muted",
                                    },
                                    " · " + a.checkin.message,
                                  ),
                                a.checkin?.at &&
                                  h(
                                    "span",
                                    { className: "muted" },
                                    " · " + date(a.checkin.at),
                                  ),
                              ),
                              h(
                                "div",
                                { className: "chub-acctacts" },
                                btn(
                                  a.enabled ? "停用" : "启用",
                                  () =>
                                    action("accounts.update", {
                                      id: a.id,
                                      enabled: !a.enabled,
                                    }),
                                  { small: true },
                                ),
                                btn(
                                  "续期",
                                  () => action("accounts.renew", { id: a.id }),
                                  { small: true },
                                ),
                                c.canBalance !== false &&
                                  btn(
                                    "查询额度",
                                    () =>
                                      action("accounts.balance", {
                                        id: a.id,
                                      }),
                                    { small: true },
                                  ),
                                c.canClaim &&
                                  ["failed", "manual"].includes(
                                    a.checkin?.state,
                                  ) &&
                                  btn(
                                    a.checkin?.state === "manual"
                                      ? "手动签到"
                                      : "重试签到",
                                    () =>
                                      action("accounts.claim", { id: a.id }),
                                    { small: true },
                                  ),
                                btn(
                                  "删除",
                                  () => {
                                    if (
                                      window.confirm(
                                        "删除账号 " + a.nickname + "？",
                                      )
                                    )
                                      void action("accounts.delete", {
                                        id: a.id,
                                      });
                                  },
                                  { small: true, kind: "danger" },
                                ),
                              ),
                              h(
                                "details",
                                { className: "chub-models" },
                                h(
                                  "summary",
                                  null,
                                  "模型 ",
                                  h("b", null, models.length),
                                  h(
                                    "span",
                                    { className: "chub-summaryhint" },
                                    (disabledModels.length
                                      ? "已隐藏 " +
                                        disabledModels.length +
                                        " · "
                                      : "") + "展开管理",
                                  ),
                                ),
                                models.length === 0
                                  ? h(
                                      "p",
                                      {
                                        className: "chub-inline muted",
                                        style: { padding: "6px 2px 0" },
                                      },
                                      "目录为空。点击“更新模型”重试，远端确认的条目会自动出现。",
                                    )
                                  : h(
                                      "div",
                                      { className: "chub-modelacts" },
                                      h(
                                        "span",
                                        { className: "chub-modelacthint" },
                                        disabledModels.length
                                          ? "已隐藏 " +
                                              disabledModels.length +
                                              " / " +
                                              models.length
                                          : "共 " +
                                              models.length +
                                              " 个，全部启用",
                                      ),
                                      btn(
                                        "全部启用",
                                        () =>
                                          action("models.setDisabled", {
                                            provider: c.id,
                                            all: true,
                                            disabled: false,
                                          }),
                                        {
                                          small: true,
                                          disabled:
                                            busy || disabledModels.length === 0,
                                          title:
                                            "启用该渠道的全部模型（含历史隐藏项）",
                                        },
                                      ),
                                      btn(
                                        "全部禁用",
                                        () =>
                                          action("models.setDisabled", {
                                            provider: c.id,
                                            models: models.map(
                                              (m: any) => m.id,
                                            ),
                                            disabled: true,
                                          }),
                                        {
                                          small: true,
                                          disabled: busy || allModelsOff,
                                          title: "禁用当前目录中的全部模型",
                                        },
                                      ),
                                    ),
                                models.length > 0 &&
                                  h(
                                    "div",
                                    { className: "chub-modellist" },
                                    ...models.map((m: any) => {
                                      const hidden = disabledModels.includes(
                                        m.id,
                                      );
                                      const rate = rateLabel(m);
                                      const note = promotionNote(m);
                                      const window = promotionWindow(m);
                                      const tip = [
                                        m.id,
                                        rate ? "计费系数 " + rate : "",
                                        note
                                          ? "活动 " +
                                            note +
                                            (window && !note.includes(window)
                                              ? "（" + window + "）"
                                              : "")
                                          : "",
                                      ]
                                        .filter(Boolean)
                                        .join(" · ");
                                      return h(
                                        "label",
                                        {
                                          key: m.id,
                                          className:
                                            "chub-model" +
                                            (hidden ? " off" : ""),
                                          title: tip,
                                        },
                                        h("input", {
                                          type: "checkbox",
                                          checked: !hidden,
                                          disabled: busy,
                                          onChange: (e: any) =>
                                            action("models.setDisabled", {
                                              provider: c.id,
                                              model: m.id,
                                              disabled: !e.target.checked,
                                            }),
                                        }),
                                        h(
                                          "span",
                                          { className: "chub-modelname" },
                                          m.name || m.id,
                                        ),
                                        note &&
                                          h(
                                            "span",
                                            {
                                              className: "chub-promo",
                                              title:
                                                "活动 " +
                                                note +
                                                (window &&
                                                !note.includes(window)
                                                  ? "（" + window + "）"
                                                  : ""),
                                            },
                                            note,
                                          ),
                                        rate &&
                                          h(
                                            "span",
                                            {
                                              className: "chub-factor",
                                              title: "计费系数 " + rate,
                                            },
                                            rate,
                                          ),
                                      );
                                    }),
                                  ),
                              ),
                            );
                          }),
                        ),
                  );
                }),
              ),
              channels.length === 0 &&
                empty(
                  "正在读取渠道",
                  "渠道列表会在插件加载完成后显示；若持续为空，请查看上方错误。",
                ),
            ),
          ),
        tab === "dashboard" &&
          h(
            "div",
            { className: "chub-body" },
            !totals
              ? empty("正在汇总用量", "数据会在首次加载后显示。")
              : h(
                  React.Fragment,
                  null,
                  h(
                    "section",
                    { className: "chub-section" },
                    h(
                      "div",
                      { className: "chub-sectionhead" },
                      h(
                        "div",
                        null,
                        h("h3", null, "用量总览"),
                        h(
                          "p",
                          { className: "chub-sectionhint" },
                          filter.range === "today"
                            ? "按本地自然日统计今日轮次与用量。"
                            : "统计全部历史；轮次/步数按明细（保留 90 天）。",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-panelhint" },
                        "已报告 ",
                        fmt(totals.reported),
                        " / ",
                        fmt(totals.attempts),
                        " 次尝试",
                      ),
                    ),
                    h(
                      "div",
                      { className: "chub-kpis" },
                      ...[
                        [
                          "轮次 / 步数",
                          fmt(counts.turns) + " / " + fmt(counts.steps),
                          fmt(stepsPerTurn, 2) + " 步/轮 · 明细保留 90 天",
                        ],
                        [
                          "Token 总量",
                          fmt(totals.totalTokens),
                          "输入与输出合计",
                        ],
                        [
                          "流式速度",
                          fmt(totals.avgTps, 1) + " tok/s",
                          fmt(totals.speedSamples) +
                            " 样本 · 首字 " +
                            fmt(totals.avgTtftMs) +
                            " ms",
                        ],
                        [
                          "整块吞吐",
                          fmt(totals.avgThroughput, 1) + " tok/s",
                          fmt(totals.throughputSamples) + " 样本 · 含首字等待",
                        ],
                        [
                          "缓存命中率",
                          pct(totals.cacheHitRate),
                          "覆盖率 " +
                            pct(totals.cacheCoverage) +
                            " · 未知不计零",
                        ],
                        [
                          "成功率",
                          pct(totals.successRate),
                          "取消 " +
                            fmt(totals.cancelled) +
                            " · 中断 " +
                            fmt(totals.interrupted),
                        ],
                      ].map(([label, value, sub]) =>
                        h(
                          "article",
                          { className: "chub-kpi", key: label },
                          h("span", { className: "chub-kpilabel" }, label),
                          h("strong", { className: "chub-kpivalue" }, value),
                          h("span", { className: "chub-kpisub" }, sub),
                        ),
                      ),
                    ),
                  ),
                  h(
                    "section",
                    { className: "chub-panel chub-chart" },
                    h(
                      "div",
                      { className: "chub-panelhead" },
                      h(
                        "div",
                        null,
                        h("h4", null, "每日 Token 消耗"),
                        h(
                          "p",
                          null,
                          "柱形是每天各自的量；下方图例是该区间的合计。悬停可看当天与各来源数值。",
                        ),
                      ),
                      h(
                        "span",
                        { className: "chub-panelhint" },
                        series.length + " 天",
                      ),
                    ),
                    series.length === 0
                      ? empty(
                          "暂无每日数据",
                          "产生真实请求后会在这里生成趋势。",
                        )
                      : h(
                          "div",
                          { className: "chub-chartbody" },
                          h(
                            "svg",
                            {
                              viewBox: "0 0 1000 130",
                              preserveAspectRatio: "none",
                              role: "img",
                              "aria-label": "每日 Token 消耗趋势",
                              className: "chub-chartsvg",
                            },
                            ...[0, 1, 2, 3].map((i) =>
                              h("line", {
                                key: "g" + i,
                                x1: 0,
                                x2: 1000,
                                y1: 6 + i * 30,
                                y2: 6 + i * 30,
                                className: "chub-gridline",
                              }),
                            ),
                            ...series.map((day: any, i: number) => {
                              const slot = 1000 / series.length;
                              // 天数少时柱子别铺满整格，居中并限宽。
                              const width = Math.min(Math.max(1, slot - 2), 36);
                              const x = i * slot + (slot - width) / 2;
                              const segments = daySegments(String(day.id));
                              /*
                               * 堆叠柱：把当天各渠道的 Token 自下而上叠起来。
                               *
                               * ⚠️ 高度按**整柱总量**换算（`maxTokens`），
                               * 每段占总高的比例与该渠道的 Token 占比一致，
                               * 所以柱高仍然可比、段长又能读出占比。
                               *
                               * ⚠️ 当天没有分渠道数据时（`dailyByProvider`
                               * 缺失或全为 0），退回画一根整柱 —— 宁可少一层
                               * 分解，也不要让已有数据凭空消失。
                               */
                              if (segments.length === 0) {
                                const height =
                                  ((day.totalTokens || 0) / maxTokens) * 108;
                                return h(
                                  "rect",
                                  {
                                    key: day.id,
                                    x,
                                    y: 118 - height,
                                    width,
                                    height,
                                    rx: 3,
                                    className: "chub-bar",
                                    fill: "color-mix(in srgb,var(--chub-accent) 68%,transparent)",
                                  },
                                  h(
                                    "title",
                                    null,
                                    day.id +
                                      " · " +
                                      fmt(day.totalTokens) +
                                      " Token · " +
                                      fmt(day.requests) +
                                      " 请求",
                                  ),
                                );
                              }
                              const sum = segments.reduce(
                                (n, s) => n + s.tokens,
                                0,
                              );
                              /**
                               * 该柱的总高（按当天总量与全局峰值换算）。
                               *
                               * ⚠️ 用 `day.totalTokens || sum`：宿主给的日汇总
                               * 与逐渠道分量理论上相等，但任一可能缺失；退到
                               * 分量之和才不会把柱子画成 0。
                               */
                              const barHeight =
                                ((day.totalTokens || sum) / maxTokens) * 108;
                              /*
                               * ⚠️ 最小可见高度 2px：真实数据里占比最小的
                               * 渠道按纯比例只有 0.1px，是**看不见**的。用户看
                               * 这张图就是为了找出「谁在用」，所以宁可轻微压缩
                               * 大段，也要保证每个渠道都留有可见的一笔。
                               */
                              const heights = stackHeights(
                                segments.map((s) => s.tokens),
                                barHeight,
                                2,
                              );
                              let cursor = 118;
                              return h(
                                "g",
                                { key: day.id },
                                ...segments.map((segment, k) => {
                                  const part = heights[k] ?? 0;
                                  cursor -= part;
                                  const share =
                                    sum > 0 ? segment.tokens / sum : 0;
                                  return h(
                                    "rect",
                                    {
                                      key: segment.provider,
                                      x,
                                      y: cursor,
                                      width,
                                      height: part,
                                      // 只有最顶段做圆角，中间段紧贴。
                                      rx: k === segments.length - 1 ? 3 : 0,
                                      className: "chub-seg",
                                      fill: colorOfProvider(segment.provider),
                                    },
                                    h(
                                      "title",
                                      null,
                                      day.id +
                                        " · " +
                                        segment.provider +
                                        " · " +
                                        fmt(segment.tokens) +
                                        " Token · 占当天 " +
                                        pct(share),
                                    ),
                                  );
                                }),
                                // 整柱的汇总提示挂在透明覆盖层上，悬停空白也能看总量。
                                h(
                                  "rect",
                                  {
                                    x,
                                    y:
                                      118 -
                                      ((day.totalTokens || 0) / maxTokens) *
                                        108,
                                    width,
                                    height:
                                      ((day.totalTokens || 0) / maxTokens) *
                                      108,
                                    fill: "transparent",
                                  },
                                  h(
                                    "title",
                                    null,
                                    day.id +
                                      " · 合计 " +
                                      fmt(day.totalTokens) +
                                      " Token · " +
                                      fmt(day.requests) +
                                      " 请求",
                                  ),
                                ),
                              );
                            }),
                          ),
                          h(
                            "div",
                            {
                              className: "chub-axis",
                              // 每根柱子一格，标签落在自己的格子里，不再用首尾拉伸。
                              style: {
                                gridTemplateColumns:
                                  "repeat(" +
                                  series.length +
                                  ", minmax(0, 1fr))",
                              },
                            },
                            ...(() => {
                              // 抽稀：约 8 个标签；末尾「最新一天」优先保留，
                              // 与它太近的前一个让位，避免最后两个日期挤在一起。
                              const step = Math.max(
                                1,
                                Math.ceil(series.length / 8),
                              );
                              const shown = new Set<number>();
                              for (let i = 0; i < series.length; i += step)
                                shown.add(i);
                              const last = series.length - 1;
                              shown.add(last);
                              for (const i of [...shown])
                                if (i !== last && last - i < step)
                                  shown.delete(i);
                              return series.map((day: any, i: number) => {
                                const text = String(day.id);
                                return h(
                                  "span",
                                  { key: "x" + day.id },
                                  shown.has(i)
                                    ? series.length > 10
                                      ? text.slice(5)
                                      : text
                                    : "",
                                );
                              });
                            })(),
                          ),
                          /*
                           * 图例：渠道 → 色块。
                           *
                           * ⚠️ 只在**真的有分渠道数据**时渲染：没有分渠道
                           * 数据时柱子是单色的，再画一排图例会误导用户以为
                           * 那些渠道都有独立分段。
                           *
                           * ⚠️ 图例数值是**整个筛选区间的合计**，而柱子是
                           * **每日**的量 —— 两者量级天然不同（用户 2026-10-21
                           * 指出过这个困惑）。故在开头显式写一行「合计」，
                           * 并标明「区间合计」，让两套数字各自有明确口径。
                           */
                          dailyProviders.length > 0 &&
                            h(
                              "div",
                              { className: "chub-legend" },
                              h(
                                "span",
                                {
                                  key: "__total",
                                  className: "chub-legendtotal",
                                  title:
                                    series.length +
                                    " 天的合计；柱形是每天各自的量",
                                },
                                "合计 ",
                                h("b", null, fmt(dailyTotalTokens)),
                                " Token · ",
                                series.length + " 天",
                              ),
                              ...dailyProviders.map((provider) => {
                                const value = providerTotals.get(provider) ?? 0;
                                return h(
                                  "span",
                                  {
                                    key: provider,
                                    className: "chub-legenditem",
                                    title:
                                      provider +
                                      " · 区间内合计 " +
                                      fmt(value) +
                                      " Token" +
                                      (dailyTotalTokens > 0
                                        ? " · 占 " +
                                          pct(value / dailyTotalTokens)
                                        : ""),
                                  },
                                  h("i", {
                                    className: "chub-legenddot",
                                    style: {
                                      background: colorOfProvider(provider),
                                    },
                                  }),
                                  h(
                                    "span",
                                    { className: "chub-legendname" },
                                    provider,
                                  ),
                                  /*
                                   * 图例带数值：柱子只有 108px 高，占比小的
                                   * 渠道即便保住 2px 可见高度，也读不出具体
                                   * 数字；把区间合计写在图例里，精确值就不必
                                   * 逐根柱子悬停。
                                   */
                                  h(
                                    "span",
                                    { className: "chub-legendvalue" },
                                    fmt(value),
                                  ),
                                );
                              }),
                            ),
                        ),
                    series.length > 0 &&
                      h(
                        "details",
                        { className: "chub-fold" },
                        h("summary", null, "查看每日明细"),
                        /*
                         * 明细表按**来源分行**：同一日期会出现在多行，
                         * 各自对应一个渠道。这样「哪天是哪家消耗的」在表格里
                         * 也能查到，不只靠柱子的颜色。
                         *
                         * 没有分渠道数据时退回按日期汇总的单行形态。
                         */
                        dailyByProvider.length > 0
                          ? table(
                              ["日期", "来源", "Token", "请求"],
                              dailyByProvider.map((row: any) => [
                                row.day,
                                row.provider,
                                fmt(row.totalTokens),
                                fmt(row.requests),
                              ]),
                              [1],
                            )
                          : table(
                              ["日期", "Token", "请求"],
                              series.map((s: any) => [
                                s.id,
                                fmt(s.totalTokens),
                                fmt(s.requests),
                              ]),
                            ),
                      ),
                  ),
                  h(
                    "div",
                    { className: "chub-stack" },
                    ...["accounts", "models"].map((key) => {
                      const rows = stats[key] ?? [];
                      return h(
                        "section",
                        { key, className: "chub-panel" },
                        h(
                          "div",
                          { className: "chub-panelhead" },
                          h(
                            "div",
                            null,
                            h(
                              "h4",
                              null,
                              key === "accounts" ? "账号透视" : "模型性能",
                            ),
                            h(
                              "p",
                              null,
                              key === "accounts"
                                ? "按账号汇总真实请求。"
                                : "按模型汇总速度与成功率。",
                            ),
                          ),
                          h(
                            "span",
                            { className: "chub-panelhint" },
                            rows.length + " 项",
                          ),
                        ),
                        rows.length === 0
                          ? empty(
                              "暂无数据",
                              key === "accounts"
                                ? "账号产生请求后会出现在这里。"
                                : "模型产生请求后会出现在这里。",
                            )
                          : table(
                              [
                                "来源 / 名称",
                                "Token",
                                "请求",
                                "成功率",
                                "流式 tok/s",
                                "整块 tok/s",
                                "首字 ms",
                              ],
                              rows.map((s: any) => [
                                /*
                                 * 「来源 / 名称」两段式。
                                 *
                                 * ⚠️ `provider` 由宿主**结构化**给出（见
                                 * `database.ts` 的 `accountStats` /
                                 * `modelGroups`），不要在这里从 `name` 或
                                 * `id` 里劈字符串 —— 账号显示名可能是任意
                                 * 文本（含 `/`），劈出来的「来源」会错。
                                 *
                                 * 模型分组本身也改成 `渠道 + 模型` 了：同名模型
                                 * 出现在多个渠道时（实测 deepseek-v4.1-flash
                                 * 横跨 4 个渠道）不再被合并成一行。
                                 */
                                h(
                                  "span",
                                  { className: "chub-source" },
                                  s.provider ?? "—",
                                  h("span", { className: "chub-sep" }, " / "),
                                  s.name ?? s.id,
                                ),
                                fmt(s.totalTokens),
                                fmt(s.requests),
                                pct(s.successRate),
                                fmt(s.avgTps, 1),
                                fmt(s.avgThroughput, 1),
                                fmt(s.avgTtftMs),
                              ]),
                            ),
                      );
                    }),
                  ),
                ),
          ),
        tab === "logs" &&
          h(
            "div",
            { className: "chub-body chub-logs" },
            h(
              "section",
              { className: "chub-section" },
              h(
                "div",
                { className: "chub-sectionhead" },
                h(
                  "div",
                  null,
                  h("h3", null, "运行日志"),
                  h(
                    "p",
                    { className: "chub-sectionhint" },
                    "共 ",
                    logs.total,
                    " 轮 · ",
                    logs.steps ?? 0,
                    " 步 · 明细保留 90 天，日汇总永久保留。",
                  ),
                ),
              ),
              h(
                "div",
                { className: "chub-panel chub-logpanel" },
                logs.items.length === 0
                  ? empty("没有匹配的请求", "调整筛选条件或等待新的推理请求。")
                  : reqTable(logs.items),
              ),
              pager(),
            ),
          ),
      );
    }
    /**
     * 侧边栏面板 id。
     *
     * ⚠️ **必须与 `main` keyed slot 的 key 完全相同**：宿主用这个 id 把一个
     * `sidebar.panellist` 图标与 `main` 里的面板页绑起来（见宿主文档
     * 「Global panel entries」）。两者写得不一致时，图标点下去抛
     * `selectPanel` 的「unknown panel」，页面根本打不开。
     */
    const PANEL_ID = "channel-hub";
    /**
     * 侧边栏图标。
     *
     * 契约（宿主文档）：`sidebar.panellist` 注册的是**图标组件**，点击由宿主
     * 自己处理（它内部调用 `selectPanel(id)`），插件不需要 `layout` 服务。
     * props 只有 `{ size, active }` —— `size` 跟随侧栏宽窄（16/18），
     * `active` 表示当前是否停在这个面板上。
     *
     * ⚠️ 图标必须是**纯装饰**：宿主已提供 `aria-label`（来自 `label()`），
     * 这里再加一次会让读屏软件念两遍。故 `aria-hidden`。
     */
    function ChannelHubIcon(props: any) {
      const size = typeof props?.size === "number" ? props.size : 18;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.8,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
        },
        // 三个叠放的通道条 + 一条脉冲线：表达「多个渠道 + 真实请求」。
        h("rect", { x: 3, y: 4, width: 18, height: 4.5, rx: 1.5 }),
        h("rect", { x: 3, y: 10.5, width: 11, height: 4.5, rx: 1.5 }),
        h("rect", { x: 3, y: 17, width: 6, height: 3.5, rx: 1.5 }),
        h("path", { d: "M17 12.5l2 2 3-3.5" }),
      );
    }
    return {
      name: "channel-hub",
      id: "dsh-channel-hub",
      inject: ["slots", "connection"],
      apply(ctx: any) {
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 35,
              label: () => "渠道中心",
            },
            ChannelHubIcon,
          ),
        );
        /**
         * 整窗主区域（本插件**唯一**的入口）。
         *
         * ⚠️ 为什么不用 `settings.section`：宿主设置面板固定 800px，减去左导航
         * 188px 与内容区左右各 24px，真实可用宽度只有约 564px；而本插件有三页、
         * 含 7 列表格与双栏图表，挤在那里面只能横向滚动。`main` 面板是
         * `width:100%;height:100%`，可以铺满窗口（实测同一 1560px 视口下
         * 可用宽度 1560px vs 564px）。
         *
         * ⚠️ **不要**为了「让用户还能在设置里找到」再加一份 `settings.section`：
         * 两个入口渲染的是同一个页面，多一处注册就多一处需要同步维护的入口，
         * 而真正解决宽度问题的是这里。侧边栏图标是它唯一的发现路径。
         */
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: PANEL_ID }, (props: any) =>
            h(Page, { ...props, ctx }),
          ),
        );
      },
    };
  },
});
