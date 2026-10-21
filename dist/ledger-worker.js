// src/storage/worker.ts
import { parentPort, workerData } from "node:worker_threads";

// src/storage/database.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

// src/core/metrics.ts
var empty = () => ({
  requests: 0,
  success: 0,
  failed: 0,
  cancelled: 0,
  interrupted: 0,
  attempts: 0,
  attemptFailures: 0,
  reported: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  cacheInput: 0,
  cacheHitTokens: 0,
  cacheSamples: 0,
  cacheWriteSamples: 0,
  reasoningSamples: 0,
  speedSum: 0,
  speedSamples: 0,
  throughputSum: 0,
  throughputSamples: 0,
  firstSum: 0,
  firstSamples: 0
});
function add(a, b) {
  const out = empty();
  for (const k of Object.keys(out))
    out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}
function measure(req, rows, countRequest = true) {
  const m = empty();
  if (countRequest) {
    m.requests = 1;
    if (req.outcome !== "running") m[req.outcome]++;
  }
  for (const a of rows) {
    m.attempts++;
    if (a.outcome === "failed") m.attemptFailures++;
    if (!a.usage) continue;
    m.reported++;
    const u = a.usage;
    m.input += u.input;
    m.output += u.output;
    m.cacheRead += u.cacheRead ?? 0;
    m.cacheWrite += u.cacheWrite ?? 0;
    m.reasoning += u.reasoning ?? 0;
    if (u.reasoning !== void 0) m.reasoningSamples++;
    if (u.cacheWrite !== void 0) m.cacheWriteSamples++;
    if (u.cacheRead !== void 0) {
      m.cacheSamples++;
      m.cacheHitTokens += u.cacheRead;
      m.cacheInput += u.input + u.cacheRead + (u.cacheWrite ?? 0);
    }
  }
  const first = rows.find((a) => a.first !== void 0);
  if (first) {
    m.firstSum = first.first - req.started;
    m.firstSamples = 1;
  }
  const final = rows.at(-1);
  const ended = final?.ended ?? req.ended;
  const outcome = final?.outcome === "running" ? req.outcome : final?.outcome;
  if (outcome === "success" && final?.usage && final.first !== void 0 && ended !== void 0 && ended > final.first) {
    m.speedSum = final.usage.output / ((ended - final.first) / 1e3);
    m.speedSamples = 1;
  }
  if (outcome === "success" && final?.usage && req.ended !== void 0 && req.ended > req.started) {
    m.throughputSum = final.usage.output / ((req.ended - req.started) / 1e3);
    m.throughputSamples = 1;
  }
  return m;
}
function present(m) {
  return {
    ...m,
    totalTokens: m.input + m.cacheRead + m.cacheWrite + m.output,
    successRate: m.success + m.failed ? m.success / (m.success + m.failed) : null,
    avgTps: m.speedSamples ? m.speedSum / m.speedSamples : null,
    avgThroughput: m.throughputSamples ? m.throughputSum / m.throughputSamples : null,
    avgTtftMs: m.firstSamples ? m.firstSum / m.firstSamples : null,
    cacheHitRate: m.cacheInput ? m.cacheHitTokens / m.cacheInput : null,
    cacheCoverage: m.reported ? m.cacheSamples / m.reported : null
  };
}

// src/core/types.ts
function dayOf(ts) {
  return new Date(ts + 8 * 36e5).toISOString().slice(0, 10);
}

// src/storage/database.ts
var LedgerDatabase = class {
  db;
  lock;
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    if (file !== ":memory:") {
      const lock = file + ".lock";
      const acquire = () => writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
        flag: "wx",
        mode: 384
      });
      try {
        acquire();
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let pid;
        try {
          pid = JSON.parse(readFileSync(lock, "utf8")).pid;
        } catch {
          throw Error("\u6570\u636E\u5E93\u9501\u635F\u574F\uFF0C\u8BF7\u68C0\u67E5 " + lock);
        }
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (e) {
          if (e.code === "ESRCH") alive = false;
        }
        if (alive) throw Error("\u6B64 profile \u7684\u6E20\u9053\u4E2D\u5FC3\u6570\u636E\u5E93\u5DF2\u88AB\u53E6\u4E00\u5B9E\u4F8B\u5360\u7528");
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
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
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
  migrate() {
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0
    );
    if (version >= 2) return;
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(requests)").all().map((c) => String(c.name))
    );
    if (!columns.has("turnId"))
      this.db.exec("ALTER TABLE requests ADD COLUMN turnId TEXT");
    if (!columns.has("sessionId"))
      this.db.exec("ALTER TABLE requests ADD COLUMN sessionId TEXT");
    this.db.exec("UPDATE requests SET turnId=id WHERE turnId IS NULL");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS request_turn ON requests(turnId, started DESC)"
    );
    this.db.exec("PRAGMA user_version=2");
  }
  begin(row) {
    this.db.prepare(
      "INSERT INTO requests(id,started,provider,model,outcome,data,turnId,sessionId) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING"
    ).run(
      row.id,
      row.started,
      row.provider,
      row.model,
      row.outcome,
      JSON.stringify(row),
      row.turnId ?? row.id,
      row.sessionId ?? null
    );
  }
  attempt(a) {
    this.db.prepare(
      "INSERT INTO attempts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data"
    ).run(a.id, a.requestId, JSON.stringify(a));
  }
  finish(req, attempts) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const old = this.db.prepare("SELECT outcome FROM requests WHERE id=?").get(req.id);
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
      this.db.prepare("UPDATE requests SET outcome=?,data=? WHERE id=?").run(req.outcome, JSON.stringify(req), req.id);
      this.merge(
        dayOf(req.started),
        req.provider,
        req.model,
        "",
        measure(req, attempts)
      );
      const groups = /* @__PURE__ */ new Map();
      for (const a of attempts) {
        if (!a.accountId) continue;
        const group = groups.get(a.accountId) ?? [];
        group.push(a);
        groups.set(a.accountId, group);
      }
      for (const [accountId, rows] of groups) {
        const last = rows.at(-1);
        this.merge(
          dayOf(req.started),
          req.provider,
          req.model,
          accountId,
          measure(
            {
              ...req,
              outcome: last.outcome === "running" ? "interrupted" : last.outcome
            },
            rows
          )
        );
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  merge(day, provider, model, accountId, m) {
    const prev = this.db.prepare(
      "SELECT metrics FROM daily WHERE day=? AND provider=? AND model=? AND accountId=?"
    ).get(day, provider, model, accountId);
    const value = add(prev ? JSON.parse(String(prev.metrics)) : empty(), m);
    this.db.prepare(
      "INSERT INTO daily VALUES(?,?,?,?,?) ON CONFLICT(day,provider,model,accountId) DO UPDATE SET metrics=excluded.metrics"
    ).run(day, provider, model, accountId, JSON.stringify(value));
  }
  recover() {
    const rows = this.db.prepare("SELECT data FROM requests WHERE outcome='running'").all();
    for (const row of rows) {
      const req = JSON.parse(String(row.data));
      const attempts = this.detail(req.id).attempts.map((a) => ({
        ...a,
        outcome: a.outcome === "running" ? "interrupted" : a.outcome,
        ended: a.ended ?? Date.now()
      }));
      this.finish(
        { ...req, outcome: "interrupted", ended: Date.now() },
        attempts
      );
    }
  }
  /** 把过滤条件折算成 SQL 子句（`list` 与统计共用）。 */
  filters(f) {
    const clauses = [];
    const args = [];
    for (const [key, value, sql] of [
      ["provider", f.provider, "provider=?"],
      ["model", f.model, "model=?"],
      ["outcome", f.outcome, "outcome=?"],
      ["from", f.from, "started>=?"],
      ["to", f.to, "started<?"]
    ]) {
      if (value !== void 0) {
        clauses.push(sql);
        args.push(value);
      }
    }
    if (f.accountId) {
      clauses.push(
        "EXISTS(SELECT 1 FROM attempts a WHERE a.requestId=requests.id AND json_extract(a.data,'$.accountId')=?)"
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
  list(f = {}) {
    const limit = Math.max(1, Math.min(100, f.limit ?? 30));
    const page = Math.max(1, f.page ?? 1);
    const { clauses, args } = this.filters(f);
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const turnOf = "COALESCE(turnId, id)";
    const total = Number(
      this.db.prepare(`SELECT COUNT(DISTINCT ${turnOf}) AS n FROM requests${where}`).get(...args)?.n ?? 0
    );
    const stepCount = Number(
      this.db.prepare("SELECT COUNT(*) AS n FROM requests" + where).get(...args)?.n ?? 0
    );
    const turns = this.db.prepare(
      `SELECT ${turnOf} AS turn FROM requests${where} GROUP BY turn ORDER BY MAX(started) DESC LIMIT ? OFFSET ?`
    ).all(...args, limit, (page - 1) * limit).map((r) => String(r.turn));
    if (turns.length === 0)
      return { total, steps: stepCount, page, limit, items: [] };
    const marks = turns.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT data FROM requests WHERE ${turnOf} IN (${marks})${clauses.length ? " AND " + clauses.join(" AND ") : ""} ORDER BY started`
    ).all(...turns, ...args).map((r) => JSON.parse(String(r.data)));
    const attemptsByRequest = /* @__PURE__ */ new Map();
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const idMarks = ids.map(() => "?").join(",");
      for (const a of this.db.prepare(
        `SELECT requestId, data FROM attempts WHERE requestId IN (${idMarks}) ORDER BY rowid`
      ).all(...ids)) {
        const key = String(a.requestId);
        const list = attemptsByRequest.get(key) ?? [];
        list.push(
          JSON.parse(String(a.data))
        );
        attemptsByRequest.set(key, list);
      }
    }
    const byTurn = /* @__PURE__ */ new Map();
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
          for (const k of Object.keys(agg))
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
            error: steps.map((s) => s.error).filter((e) => typeof e === "string").at(-1),
            stepCount: steps.length,
            attempts: last.attempts,
            metrics: present(agg),
            steps
          }
        ];
      })
    };
  }
  detail(id) {
    const row = this.db.prepare("SELECT data FROM requests WHERE id=?").get(id);
    return {
      request: row ? JSON.parse(String(row.data)) : null,
      attempts: this.db.prepare("SELECT data FROM attempts WHERE requestId=? ORDER BY rowid").all(id).map((r) => JSON.parse(String(r.data)))
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
  dailyWhere(f, scope) {
    const clauses = [scope === "logical" ? "accountId=''" : "accountId<>''"];
    const args = [];
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
    if (f.from !== void 0) {
      clauses.push("day>=?");
      args.push(dayOf(f.from));
    }
    if (f.to !== void 0) {
      clauses.push("day<=?");
      args.push(dayOf(f.to - 1));
    }
    return { where: " WHERE " + clauses.join(" AND "), args };
  }
  dailyMetrics(f, scope) {
    const { where, args } = this.dailyWhere(f, scope);
    return this.db.prepare("SELECT * FROM daily" + where).all(...args);
  }
  promote(id, m) {
    return { id, name: this.get("identity:" + id) ?? id, ...present(m) };
  }
  /**
   * 当前筛选范围内的轮次 / 步数。
   *
   * ⚠️ 明细（`requests`）只保留 90 天，日汇总永久保留 —— 所以这两个数是
   * 「可统计窗口内」的口径，界面上必须写明，不能当作全历史。
   */
  requestCounts(f) {
    const { clauses, args } = this.filters(f);
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const row = this.db.prepare(
      `SELECT COUNT(*) AS steps, COUNT(DISTINCT COALESCE(turnId,id)) AS turns FROM requests${where}`
    ).get(...args);
    return {
      turns: Number(row?.turns ?? 0),
      steps: Number(row?.steps ?? 0)
    };
  }
  stats(f = {}) {
    const scope = f.accountId ? "per-account" : "logical";
    const rows = this.dailyMetrics(f, scope);
    const groups = (key) => {
      const out = /* @__PURE__ */ new Map();
      for (const r of rows) {
        const k = String(r[key]);
        out.set(k, add(out.get(k) ?? empty(), JSON.parse(String(r.metrics))));
      }
      return [...out].map(([id, m]) => this.promote(id, m));
    };
    return {
      totals: present(
        rows.reduce((m, r) => add(m, JSON.parse(String(r.metrics))), empty())
      ),
      counts: this.requestCounts(f),
      series: groups("day").sort((a, b) => a.id.localeCompare(b.id)),
      models: groups("model"),
      providers: groups("provider"),
      accounts: this.accountStats(f)
    };
  }
  accountStats(f) {
    const { where, args } = this.dailyWhere(f, "per-account");
    const rows = this.db.prepare("SELECT provider, accountId, metrics FROM daily" + where).all(...args);
    const out = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const id = String(r.provider) + "/" + String(r.accountId);
      out.set(id, add(out.get(id) ?? empty(), JSON.parse(String(r.metrics))));
    }
    return [...out].map(([id, m]) => this.promote(id, m));
  }
  prune(now = Date.now()) {
    this.db.prepare("DELETE FROM requests WHERE started<? AND outcome<>'running'").run(now - 90 * 864e5);
  }
  get(key) {
    const row = this.db.prepare("SELECT data FROM kv WHERE key=?").get(key);
    return row ? JSON.parse(String(row.data)) : void 0;
  }
  set(key, value) {
    this.db.prepare(
      "INSERT INTO kv VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data"
    ).run(key, JSON.stringify(value));
  }
  close() {
    this.db.close();
    if (this.lock) {
      unlinkSync(this.lock);
      this.lock = void 0;
    }
  }
};

// src/storage/worker.ts
var db = new LedgerDatabase(workerData.file);
parentPort.on("message", ({ id, method, args }) => {
  try {
    const allowed = [
      "begin",
      "attempt",
      "finish",
      "list",
      "detail",
      "stats",
      "prune",
      "get",
      "set",
      "close"
    ];
    if (!allowed.includes(method)) throw Error("Unknown database operation");
    const result = db[method](...args);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error) });
  }
});
parentPort.postMessage({ ready: true });
