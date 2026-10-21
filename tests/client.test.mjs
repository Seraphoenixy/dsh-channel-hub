import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
const source = readFileSync(
  new URL("../dist/client.js", import.meta.url),
  "utf8",
);
// esbuild 默认把非 ASCII 字面量写成 `\uXXXX`（大写十六进制），部分字符（如
// `·`）写成 `\xNN`。断言时统一解码，避免依赖具体转义形式。
const escape = (text) =>
  [...text]
    .map((ch) =>
      ch.charCodeAt(0) > 0x7f
        ? "\\u" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
        : ch,
    )
    .join("");
const decoded = source
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  )
  .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
test("built client registers one channel-hub section with explicit service dependencies", () => {
  let definition;
  const element = (type, props, ...children) => ({ type, props, children });
  const React = {
    createElement: element,
    Fragment: "fragment",
    useState: (initial) => [initial, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect() {},
  };
  const context = {
    window: {
      __ModuleLoader__: {
        load(d) {
          definition = d;
        },
      },
    },
    setInterval,
    clearInterval,
    setTimeout,
    document: { hidden: false },
  };
  vm.runInNewContext(source, context);
  assert.equal(definition.id, "dsh-channel-hub");
  const plugin = definition.factory((name) => {
    assert.equal(name, "react");
    return React;
  });
  assert.deepEqual(Array.from(plugin.inject), ["slots", "connection"]);
  let render;
  plugin.apply({
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(meta, view) {
        assert.equal(meta.id, "channel-hub");
        render = view;
      },
    },
    connection: {
      rpc: {
        call() {
          throw Error("No automatic network during render");
        },
      },
    },
  });
  const component = render({});
  const tree = component.type(component.props);
  const text = JSON.stringify(tree);
  for (const label of ["渠道", "数据看板", "运行日志"])
    assert.ok(text.includes(label));
  assert.ok(!text.includes("EAC"));
});

test("Loomy SMS login collects phone and code in-page instead of window.prompt", () => {
  // 宿主界面跑在 Electron 渲染进程：那里的 `prompt()` 未实现，调用即抛异常，
  // 「短信登录」按钮会变成点了没反应（也没有错误提示）。表单必须留在页面内。
  assert.ok(
    !/window\s*\.\s*prompt/.test(source),
    "window.prompt is unsupported in the host renderer",
  );
  // esbuild 默认把非 ASCII 字面量写成 `\uXXXX`（大写十六进制）。
  for (const label of ["短信登录", "获取验证码", "提交登录", "短信验证码"])
    assert.ok(
      source.includes(escape(label)),
      "missing SMS form control: " + label,
    );
  assert.ok(source.includes("chub-smsform"));
});

test("run log counts turns and reports streaming speed separately from bulk throughput", () => {
  // 运行日志按轮次统计（一行一轮），且「流式速度」与「整块吞吐」是两个独立
  // 口径，不能合并成一个平均值；看板同时给出轮次维度。
  for (const label of ["流式速度", "整块吞吐", "轮次 / 步数", "轮 ·", "步 ·", "次调用"])
    assert.ok(decoded.includes(label), "missing label: " + label);
  // 详情只保留上一次调用的原始数据，不再逐层展开每一步。
  assert.ok(!source.includes("chub-steps"), "per-step list should be gone");
  assert.ok(source.includes("chub-pre"), "detail payload should stay");
});

test("panel auto-refresh backs off after a failed round", () => {
  // 正常 10 秒一轮；失败后退避，避免记账故障时每 10 秒重打 4 个请求。
  assert.ok(decoded.includes("失败后退避"), "hint should disclose backoff");
  assert.ok(
    source.includes("setTimeout") && !source.includes("setInterval(refresh"),
    "panel refresh should be a re-armed timeout, not a fixed interval",
  );
});

test("daily chart axis lays labels out per bar slot", () => {
  // 原来用 flex + space-between 把首尾标签顶到卡片两端，比柱子各偏半格；
  // 现在按柱数等分成网格，每格居中。
  assert.ok(
    decoded.includes(".chub-axis{display:grid"),
    "axis must be a grid",
  );
  assert.ok(
    decoded.includes("gridTemplateColumns"),
    "axis must repeat one column per bar",
  );
});

test("package rows show the upstream expiry inline, not only in a hover title", () => {
  // 资源包类渠道（Buddy / WorkBuddy / Qoder / LobsterAI / Trae）会下发扣费截止
  // 或到期时间，Gemini 下发窗口重置时刻。原先这些只在悬停 title 里，
  // 用户必须逐行悬停才看得到；现在同时渲染在包标题行上。
  assert.ok(source.includes("chub-pkgwhen"), "missing inline expiry element");
  for (const label of ["到期 ", "周期至 "])
    assert.ok(
      source.includes(escape(label)),
      "missing expiry label: " + label,
    );
});
