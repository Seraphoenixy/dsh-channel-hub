import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { add, empty, measure, present, type Metrics } from "../core/metrics.ts";
import {
  dayOf,
  type Attempt,
  type RequestRow,
  type Filter,
} from "../core/types.ts";
export class LedgerDatabase {
  readonly db: DatabaseSync;
  private lock?: string;
  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (file !== ":memory:") {
      const lock = file + ".lock";
      const acquire = () =>
        writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
          flag: "wx",
          mode: 0o600,
        });
      try {
        acquire();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid: number;
        try {
          pid = JSON.parse(readFileSync(lock, "utf8")).pid;
        } catch {
          throw Error("数据库锁损坏，请检查 " + lock);
        }
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        }
        if (alive) throw Error("此 profile 的渠道中心数据库已被另一实例占用");
        unlinkSync(lock);
        acquire();
      }
      this.lock = lock;
    }
    try {
      this.db = new DatabaseSync(file);
    } catch (e) {
      if (this.lock) unlinkSync(this.lock);
      throw e;
    }
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, started INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, outcome TEXT NOT NULL, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS request_time ON requests(started DESC);
 CREATE INDEX IF NOT EXISTS request_channel ON requests(provider,model,started DESC);
 CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY, requestId TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE, data TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS attempt_request ON attempts(requestId);
 CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, accountId TEXT NOT NULL, metrics TEXT NOT NULL, PRIMARY KEY(day,provider,model,accountId));
 CREATE INDEX IF NOT EXISTS daily_account ON daily(provider,accountId,day);
 CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, data TEXT NOT NULL);
 PRAGMA user_version=1;`);
    this.migrate();
    this.recover();
  }
  /**
   * 结构迁移。
   *
   * v2：`requests` 增加 `turnId` / `sessionId` 两列，用于「按轮次统计」。
   * 旧行没有轮次信息 —— 回填成各自成轮（`turnId = id`），与修改前「按步」
   * 的口径完全一致，不会把历史数据编造进某一轮。
   */
  private migrate() {
    const version = Number(
      (
        this.db.prepare("PRAGMA user_version").get() as {
          user_version?: number;
        }
      )?.user_version ?? 0,
    );
    if (version >= 2) return;
    const columns = new Set(
      (
        this.db.prepare("PRAGMA table_info(requests)").all() as {
          name?: string;
        }[]
      ).map((c) => String(c.name)),
    );
    if (!columns.has("turnId"))
      this.db.exec("ALTER TABLE requests ADD COLUMN turnId TEXT");
    if (!columns.has("sessionId"))
      this.db.exec("ALTER TABLE requests ADD COLUMN sessionId TEXT");
    this.db.exec("UPDATE requests SET turnId=id WHERE turnId IS NULL");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS request_turn ON requests(turnId, started DESC)",
    );
    this.db.exec("PRAGMA user_version=2");
  }
  begin(row: RequestRow) {
    this.db
      .prepare(
        "INSERT INTO requests(id,started,provider,model,outcome,data,turnId,sessionId) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
      )
      .run(
        row.id,
        row.started,
        row.provider,
        row.model,
        row.outcome,
        JSON.stringify(row),
        row.turnId ?? row.id,
        row.sessionId ?? null,
      );
  }
  attempt(a: Attempt) {
    this.db
      .prepare(
        "INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(a.id, a.requestId, JSON.stringify(a));
  }
  finish(req: RequestRow, attempts: Attempt[]) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db
        .prepare("SELECT outcome FROM requests WHERE id=?")
        .get(req.id);
      if (!old) {
        throw Error("Unknown request");
      }
      if (old.outcome !== "running") {
        this.db.exec("COMMIT");
        return;
      }
      for (const a of attempts) {
        this.attempt(a);
        if (a.accountId && a.accountName)
          this.set("identity:" + a.provider + "/" + a.accountId, a.accountName);
      }
      this.db
        .prepare("UPDATE requests SET outcome=?,data=? WHERE id=?")
        .run(req.outcome, JSON.stringify(req), req.id);
      // Empty account is the logical request row. Physical account rows carry usage without duplicating requests globally.
      this.merge(
        dayOf(req.started),
        req.provider,
        req.model,
        "",
        measure(req, attempts),
      );
      const groups = new Map<string, Attempt[]>();
      for (const a of attempts) {
        if (!a.accountId) continue;
        const group = groups.get(a.accountId) ?? [];
        group.push(a);
        groups.set(a.accountId, group);
      }
      for (const [accountId, rows] of groups) {
        const last = rows.at(-1)!;
        this.merge(
          dayOf(req.started),
          req.provider,
          req.model,
          accountId,
          measure(
            {
              ...req,
              outcome:
                last.outcome === "running" ? "interrupted" : last.outcome,
            },
            rows,
          ),
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private merge(
    day: string,
    provider: string,
    model: string,
    accountId: string,
    m: Metrics,
  ) {
    const prev = this.db
      .prepare(
        "SELECT metrics FROM daily WHERE day=? AND provider=? AND model=? AND accountId=?",
      )
      .get(day, provider, model, accountId);
    const value = add(prev ? JSON.parse(String(prev.metrics)) : empty(), m);
    this.db
      .prepare(
        "INSERT INTO daily VALUES(?,?,?,?,?) ON CONFLICT(day,provider,model,accountId) DO UPDATE SET metrics=excluded.metrics",
      )
      .run(day, provider, model, accountId, JSON.stringify(value));
  }
  recover() {
    const rows = this.db
      .prepare("SELECT data FROM requests WHERE outcome='running'")
      .all();
    for (const row of rows) {
      const req = JSON.parse(String(row.data)) as RequestRow;
      const attempts = this.detail(req.id).attempts.map((a) => ({
        ...a,
        outcome: a.outcome === "running" ? ("interrupted" as const) : a.outcome,
        ended: a.ended ?? Date.now(),
      }));
      this.finish(
        { ...req, outcome: "interrupted", ended: Date.now() },
        attempts,
      );
    }
  }
  /** 把过滤条件折算成 SQL 子句（`list` 与统计共用）。 */
  private filters(f: Filter) {
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    for (const [key, value, sql] of [
      ["provider", f.provider, "provider=?"],
      ["model", f.model, "model=?"],
      ["outcome", f.outcome, "outcome=?"],
      ["from", f.from, "started>=?"],
      ["to", f.to, "started<?"],
    ] as const) {
      if (value !== undefined) {
        clauses.push(sql);
        args.push(value);
      }
    }
    if (f.accountId) {
      clauses.push(
        "EXISTS(SELECT 1 FROM attempts a WHERE a.requestId=requests.id AND json_extract(a.data,'$.accountId')=?)",
      );
      args.push(f.accountId);
    }
    return { clauses, args };
  }
  /**
   * 运行日志：**按轮次分页**，每个条目是一轮，`steps` 里是该轮的逐步明细。
   *
   * 一轮 = 同一条用户消息引发的全部模型调用（见 `RequestRow.turnId`）。
   * `total` 是匹配的轮数、`steps` 是匹配的调用数 —— 两个口径都回传，
   * 界面上明确写成「N 轮 / M 步」，不再把步数冒充成请求数。
   */
  list(f: Filter = {}) {
    const limit = Math.max(1, Math.min(100, f.limit ?? 30));
    const page = Math.max(1, f.page ?? 1);
    const { clauses, args } = this.filters(f);
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const turnOf = "COALESCE(turnId, id)";
    const total = Number(
      this.db
        .prepare(`SELECT COUNT(DISTINCT ${turnOf}) AS n FROM requests${where}`)
        .get(...args)?.n ?? 0,
    );
    const stepCount = Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM requests" + where).get(...args)
        ?.n ?? 0,
    );
    const turns = this.db
      .prepare(
        `SELECT ${turnOf} AS turn FROM requests${where} GROUP BY turn ORDER BY MAX(started) DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, (page - 1) * limit)
      .map((r) => String((r as { turn?: unknown }).turn));
    if (turns.length === 0)
      return { total, steps: stepCount, page, limit, items: [] };
    const marks = turns.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT data FROM requests WHERE ${turnOf} IN (${marks})${clauses.length ? " AND " + clauses.join(" AND ") : ""} ORDER BY started`,
      )
      .all(...turns, ...args)
      .map((r) => JSON.parse(String(r.data)) as RequestRow);
    // 一次取完本页所有请求的尝试，避免逐条 detail() 的 N+1 查询。
    const attemptsByRequest = new Map<string, Attempt[]>();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const idMarks = ids.map(() => "?").join(",");
      for (const a of this.db
        .prepare(
          `SELECT requestId, data FROM attempts WHERE requestId IN (${idMarks}) ORDER BY rowid`,
        )
        .all(...ids)) {
        const key = String((a as { requestId?: unknown }).requestId);
        const list = attemptsByRequest.get(key) ?? [];
        list.push(
          JSON.parse(String((a as { data?: unknown }).data)) as Attempt,
        );
        attemptsByRequest.set(key, list);
      }
    }
    const byTurn = new Map<string, RequestRow[]>();
    for (const row of rows) {
      const key = row.turnId ?? row.id;
      const group = byTurn.get(key) ?? [];
      group.push(row);
      byTurn.set(key, group);
    }
    return {
      total,
      steps: stepCount,
      page,
      limit,
      items: turns.flatMap((turn) => {
        const group = byTurn.get(turn) ?? [];
        if (group.length === 0) return [];
        const agg = empty();
        const steps = group.map((r) => {
          const attempts = attemptsByRequest.get(r.id) ?? [];
          const m = measure(r, attempts);
          for (const k of Object.keys(agg) as (keyof Metrics)[])
            agg[k] += m[k];
          return { ...r, attempts, metrics: present(m) };
        });
        const first = steps[0];
        const last = steps[steps.length - 1];
        return [
          {
            // 行标识沿用轮次 id；`attempts` 保留最后一次调用的尝试，供旧视图兼容。
            id: turn,
            turnId: turn,
            sessionId: last.sessionId,
            started: first.started,
            ended: last.ended,
            provider: last.provider,
            model: last.model,
            // 一轮的结果取**最后一次调用**：中间步失败后重试成功，这一轮就是成功。
            outcome: last.outcome,
            error: steps
              .map((s) => s.error)
              .filter((e): e is string => typeof e === "string")
              .at(-1),
            stepCount: steps.length,
            attempts: last.attempts,
            metrics: present(agg),
            steps,
          },
        ];
      }),
    };
  }

  detail(id: string) {
    const row = this.db.prepare("SELECT data FROM requests WHERE id=?").get(id);
    return {
      request: row ? JSON.parse(String(row.data)) : null,
      attempts: this.db
        .prepare("SELECT data FROM attempts WHERE requestId=? ORDER BY rowid")
        .all(id)
        .map((r) => JSON.parse(String(r.data)) as Attempt),
    };
  }
  /**
   * `daily` 的过滤条件下推到 SQL。
   *
   * 原实现每次统计都 `SELECT * FROM daily`，再在内存里按 provider / model /
   * 时间筛 —— 日汇总永久保留，历史越长每次刷新（前端 10 秒一次）越贵。
   * 现在按 `scope` 区分「合计行（accountId=''）」与「账号行（accountId<>''）」，
   * 其余条件全部落到 WHERE；`daily` 的主键以 `day` 开头、另有
   * `daily_account(provider,accountId,day)`，两类查询都能走索引。
   */
  private dailyWhere(f: Filter, scope: "logical" | "per-account") {
    const clauses = [scope === "logical" ? "accountId=''" : "accountId<>''"];
    const args: (string | number)[] = [];
    if (f.provider) {
      clauses.push("provider=?");
      args.push(f.provider);
    }
    if (f.model) {
      clauses.push("model=?");
      args.push(f.model);
    }
    if (scope === "per-account" && f.accountId) {
      clauses.push("accountId=?");
      args.push(f.accountId);
    }
    if (f.from !== undefined) {
      clauses.push("day>=?");
      args.push(dayOf(f.from));
    }
    if (f.to !== undefined) {
      clauses.push("day<=?");
      args.push(dayOf(f.to - 1));
    }
    return { where: " WHERE " + clauses.join(" AND "), args };
  }
  private dailyMetrics(f: Filter, scope: "logical" | "per-account") {
    const { where, args } = this.dailyWhere(f, scope);
    // 只取需要的行（过滤已下推）；列仍然全取，因为分组要用 day/model/provider。
    return this.db.prepare("SELECT * FROM daily" + where).all(...args);
  }
  private promote(id: string, m: Metrics) {
    return { id, name: this.get("identity:" + id) ?? id, ...present(m) };
  }
  /**
   * 当前筛选范围内的轮次 / 步数。
   *
   * ⚠️ 明细（`requests`）只保留 90 天，日汇总永久保留 —— 所以这两个数是
   * 「可统计窗口内」的口径，界面上必须写明，不能当作全历史。
   */
  private requestCounts(f: Filter) {
    const { clauses, args } = this.filters(f);
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS steps, COUNT(DISTINCT COALESCE(turnId,id)) AS turns FROM requests${where}`,
      )
      .get(...args) as { steps?: unknown; turns?: unknown } | undefined;
    return {
      turns: Number(row?.turns ?? 0),
      steps: Number(row?.steps ?? 0),
    };
  }
  stats(f: Filter = {}) {
    // 选了账号就按「账号物理行」统计（与选账号前一致）；否则用合计行。
    const scope = f.accountId ? "per-account" : "logical";
    const rows = this.dailyMetrics(f, scope);
    const groups = (key: "day" | "model" | "provider") => {
      const out = new Map<string, Metrics>();
      for (const r of rows) {
        const k = String((r as Record<string, unknown>)[key]);
        out.set(k, add(out.get(k) ?? empty(), JSON.parse(String(r.metrics))));
      }
      return [...out].map(([id, m]) => this.promote(id, m));
    };
    /**
     * 模型分组：**按 渠道 + 模型**，不是纯模型名。
     *
     * ⚠️ **真实缺陷（2026-10-21，用户要求「名称列体现来源」时发现）**：
     * 旧实现只按 `model` 分组，而同一模型名会出现在多个渠道上 —— 实测
     * `deepseek-v4.1-flash` 同时存在于 workbuddy / trae / codearts / buddy，
     * `glm-5.3-flash` 也同时存在于 buddy 与 trae。合并成一行后，那几个渠道的
     * 速度与成功率被算成一个平均值，用户无法判断「是哪个渠道慢」。
     *
     * 键取 `provider + "/" + model`，与 `accountStats` 的账号键同形，
     * 界面因此可以统一按「来源 / 名称」显示。
     */
    const modelGroups = () => {
      const out = new Map<string, Metrics & { provider: string }>();
      for (const r of rows) {
        const record = r as Record<string, unknown>;
        const provider = String(record.provider);
        const model = String(record.model);
        const key = provider + "/" + model;
        const previous = out.get(key);
        out.set(key, {
          ...add(previous ?? empty(), JSON.parse(String(record.metrics))),
          provider,
        });
      }
      return [...out].map(([key, m]) => {
        const { provider, ...metrics } = m;
        // 名字仍按 identity 表补（模型没有 identity 记录时回落到模型名本身）。
        return { ...this.promote(key, metrics), provider, model: key.slice(provider.length + 1) };
      });
    };
    return {
      totals: present(
        rows.reduce((m, r) => add(m, JSON.parse(String(r.metrics))), empty()),
      ),
      counts: this.requestCounts(f),
      series: groups("day").sort((a, b) => a.id.localeCompare(b.id)),
      /**
       * 每日 × 渠道的交叉统计（按本地自然日）。
       *
       * ⚠️ 原有的 `series` 只按日期分组，所有渠道混成一根柱子 —— 用户
       * （2026-10-21）要求「每日消耗按来源分别统计」。这里额外给出交叉维度，
       * 让界面画**按渠道分段的堆叠柱**，既能看当天总量，也能看各渠道占比。
       *
       * 结构：`{ day, provider, ...metrics }` 的扁平数组，**已按日期升序、
       * 同日内按 Token 降序**排序 —— 排序放在宿主侧，保证柱段顺序稳定，
       * 不因对象键序或查询顺序抖动。
       */
      dailyByProvider: (() => {
        const bucket = new Map<
          string,
          { day: string; provider: string; metrics: Metrics }
        >();
        for (const r of rows) {
          const record = r as Record<string, unknown>;
          const day = String(record.day);
          const provider = String(record.provider);
          const key = day + "\u0000" + provider;
          const previous = bucket.get(key);
          bucket.set(key, {
            day,
            provider,
            metrics: add(
              previous?.metrics ?? empty(),
              JSON.parse(String(record.metrics)),
            ),
          });
        }
        return [...bucket.values()]
          .map((entry) => ({
            day: entry.day,
            provider: entry.provider,
            ...present(entry.metrics),
          }))
          .sort(
            (a, b) =>
              a.day.localeCompare(b.day) ||
              (b.totalTokens ?? 0) - (a.totalTokens ?? 0) ||
              a.provider.localeCompare(b.provider),
          );
      })(),
      models: modelGroups(),
      providers: groups("provider"),
      accounts: this.accountStats(f),
    };
  }
  /**
   * 账号分组：键是 `provider/accountId`。
   *
   * ⚠️ `provider` 必须**单独回传**，不能只靠 `promote` 去猜：`promote` 用
   * `identity:<provider>/<accountId>` 查显示名，查不到时把整串当名字，
   * 界面就分不出「来源」与「账号」两段。返回结构化字段后，界面按
   * 「来源 / 名称」渲染，两边都不必解析字符串。
   */
  private accountStats(f: Filter) {
    const { where, args } = this.dailyWhere(f, "per-account");
    const rows = this.db
      .prepare("SELECT provider, accountId, metrics FROM daily" + where)
      .all(...args);
    const out = new Map<string, { metrics: Metrics; provider: string; accountId: string }>();
    for (const r of rows) {
      const provider = String(r.provider);
      const accountId = String(r.accountId);
      const key = provider + "/" + accountId;
      const previous = out.get(key);
      out.set(key, {
        metrics: add(previous?.metrics ?? empty(), JSON.parse(String(r.metrics))),
        provider,
        accountId,
      });
    }
    return [...out].map(([key, entry]) => ({
      ...this.promote(key, entry.metrics),
      provider: entry.provider,
      accountId: entry.accountId,
    }));
  }
  prune(now = Date.now()) {
    this.db
      .prepare("DELETE FROM requests WHERE started<? AND outcome<>'running'")
      .run(now - 90 * 86400000);
  }
  get(key: string) {
    const row = this.db.prepare("SELECT data FROM kv WHERE key=?").get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      )
      .run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
    if (this.lock) {
      unlinkSync(this.lock);
      this.lock = undefined;
    }
  }
}
