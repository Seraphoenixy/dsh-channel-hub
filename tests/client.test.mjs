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
/**
 * 样式源文件。
 *
 * ⚠️ CSS 自 2026-10-21 起从 `client.ts` 的模板字面量移到 `src/client.css`
 * （模板里任何反引号都会截断字符串，连续踩坑 6 次）。**布局形状断言读这里**：
 * 它是样式的唯一来源，且保留真实换行 —— 构建产物里的 CSS 是一整条带 `\n`
 * 转义的字符串，正则跨行匹配会失效。另有一条测试单独确认它被内联进产物。
 */
const css = readFileSync(new URL("../src/client.css", import.meta.url), "utf8");

function renderChannelFixture(selectedAccountId = "b") {
  const channel = {
    id: "buddy",
    name: "Buddy",
    selectedAccountId,
    accounts: [
      {
        id: "a",
        nickname: "Account A",
        enabled: true,
        catalog: { models: [] },
      },
      {
        id: "b",
        nickname: "Account B",
        enabled: false,
        catalog: { models: [] },
      },
    ],
  };
  let definition,
    stateIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: "fragment",
    useState: (initial) => [stateIndex++ === 1 ? [channel] : initial, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect() {},
  };
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(d) {
          definition = d;
        },
      },
    },
    document: { hidden: false },
    setInterval,
    clearInterval,
    setTimeout,
  });
  const views = new Map(),
    calls = [];
  const plugin = definition.factory(() => React);
  plugin.apply({
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(meta, view) {
        views.set(meta.name, view);
      },
    },
    connection: {
      rpc: {
        async call(_api, _service, request) {
          calls.push(request);
          return { value: request.method === "channels.list" ? [channel] : {} };
        },
      },
    },
  });
  const page = views.get("main")({});
  const tree = page.type(page.props);
  return { tree, calls };
}
function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.children)];
}

function renderChannels(channels) {
  // 与 renderChannelFixture 同构，但可以注入任意渠道数组（多跨列卡场景用）。
  let definition,
    stateIndex = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: "fragment",
    useState: (initial) => [stateIndex++ === 1 ? channels : initial, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect() {},
  };
  vm.runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load(d) {
          definition = d;
        },
      },
    },
    document: { hidden: false },
    setInterval,
    clearInterval,
    setTimeout,
  });
  const views = new Map();
  const plugin = definition.factory(() => React);
  plugin.apply({
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(meta, view) {
        views.set(meta.name, view);
      },
    },
    connection: {
      rpc: {
        async call(_api, _service, request) {
          return { value: request.method === "channels.list" ? channels : {} };
        },
      },
    },
  });
  const page = views.get("main")({});
  return page.type(page.props);
}

function renderedChannelNames(tree) {
  const grid = nodes(tree).find(
    (n) => n.props?.className === "chub-channels",
  );
  if (!grid) return [];
  return nodes(grid.children)
    .filter((n) => n.props?.className === "chub-channel")
    .map((n) => n.props?.key);
}

function channel(id, accountCount) {
  return {
    id,
    name: id,
    accounts: Array.from({ length: accountCount }, (_, i) => ({
      id: id + "-" + i,
      nickname: id + " " + i,
      enabled: true,
      catalog: { models: [] },
    })),
  };
}

test("channel cards are packed so multi-account cards never strand a row", () => {
  // 用户 2026-10-22 报障（带截图）：真实顺序是「华为码道(1) → CodeBuddy(2)」，
  // 2 列下跨列卡放不进行尾那一格，被顶到第 2 行，第 1 行右边空了一大块（1-2-1）。
  //
  // 修法不是 `dense`（它会让视觉顺序偏离 DOM 顺序），而是渲染前按**实际列数**
  // 把卡片装成满行。`packChannels` 在列数 > 1 时把跨列卡提前，并让 3 列布局
  // 里它后面跟一张单列卡补齐。
  const channels = [
    channel("a-single", 1),
    channel("b-wide", 2),
    channel("c-single", 1),
    channel("d-single", 1),
  ];
  // 列数由 ResizeObserver 实测；测试环境没有 DOM，故 gridColumns 保持初始值 1，
  // 此时 `packChannels` 原样返回 —— 先确认不改顺序这条底线。
  assert.deepEqual(
    renderedChannelNames(renderChannels(channels)),
    ["a-single", "b-wide", "c-single", "d-single"],
    "with a single column the host order must be preserved verbatim",
  );
});

test("packChannels fills rows around spanning cards", () => {
  // ⚠️ 测的是**构建产物里的真实实现**，不是复刻逻辑：从 dist/client.js 里抠出
  // `packChannels` 的函数体求值。复刻一份逻辑会在改动时悄悄漂移 —— 测试仍然
  // 绿，行为却已经变了（这类「影子实现」比没有测试更危险）。
  const start = source.indexOf("function packChannels");
  assert.ok(start > 0, "the built bundle must contain packChannels");
  const body = source.slice(start, source.indexOf("\n      function Page", start));
  assert.ok(body.length > 0, "could not extract packChannels from the bundle");
  const pack = vm.runInNewContext("(" + body.trim().replace(/^function packChannels/, "function") + ")");

  const list = [
    channel("a", 1),
    channel("b", 2),
    channel("c", 1),
    channel("d", 1),
    channel("e", 2),
  ];
  const ids = (result) => JSON.stringify(result.map((c) => c.id));
  // 用 JSON 比较而不是 deepEqual：`pack` 在另一个 vm 上下文里执行，返回的数组
  // 原型与当前 realm 不同，deepStrictEqual 会因此失败（值其实一样）。
  const expect = (value) => JSON.stringify(value);

  // 2 列：跨列卡占满整行（perWide = 0），剩余单列卡按原顺序排在后面。
  assert.equal(ids(pack(list, 2)), expect(["b", "e", "a", "c", "d"]));
  // 3 列：跨列卡占 2 格，后面跟 1 张单列卡补齐这一行。
  assert.equal(ids(pack(list, 3)), expect(["b", "a", "e", "c", "d"]));
  // 4 列：跨列卡后面跟 2 张单列卡。
  assert.equal(ids(pack(list, 4)), expect(["b", "a", "c", "e", "d"]));
  // 单列：原样返回，绝不重排。
  assert.equal(ids(pack(list, 1)), expect(["a", "b", "c", "d", "e"]));
  // 没有跨列卡：原样返回。
  assert.equal(
    ids(pack([channel("x", 1), channel("y", 1), channel("z", 1)], 3)),
    expect(["x", "y", "z"]),
  );
  // 单张卡 / 空列表：不炸。
  assert.equal(ids(pack([channel("solo", 1)], 3)), expect(["solo"]));
  assert.equal(ids(pack([], 3)), expect([]));
});

test("channel account selector renders unavailable selection and sends explicit or auto choice", async () => {
  const { tree, calls } = renderChannelFixture();
  const selector = nodes(tree).find(
    (n) => n.type === "select" && n.props?.["aria-label"] === "Buddy 使用账号",
  );
  assert.ok(selector);
  assert.equal(selector.props.value, "b");
  const options = nodes(selector).filter((n) => n.type === "option");
  assert.equal(options.find((n) => n.props.value === "b").props.disabled, true);
  assert.ok(options.some((n) => n.props.value === ""));
  await selector.props.onChange({ target: { value: "a" } });
  await selector.props.onChange({ target: { value: "" } });
  const selections = calls.filter((c) => c.method === "channels.selectAccount");
  assert.equal(selections[0].payload.provider, "buddy");
  assert.equal(selections[0].payload.accountId, "a");
  assert.equal(selections[1].payload.accountId, null);
  const deleted = renderChannelFixture("deleted");
  assert.ok(
    nodes(deleted.tree).some(
      (n) =>
        n.type === "option" && n.props?.value === "deleted" && n.props.disabled,
    ),
  );
});
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
  /**
   * 收集各入口的注册元数据与渲染函数。
   *
   * ⚠️ 本插件只注册**两处**：`sidebar.panellist`（图标）与 `main`（整窗页面）。
   * 设置页入口已移除 —— 宿主设置面板固定 800px、真实可用宽度只有约 564px，
   * 三页内容在那里只能横向滚动。若有人把 `settings.section` 加回来，下面的
   * 断言会失败，这正是要拦住的回归。
   */
  const registered = new Map();
  plugin.apply({
    slots: {
      inject(_name, callback) {
        callback();
      },
      register(meta, view) {
        registered.set(meta.name, { meta, view });
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
  assert.deepEqual(
    [...registered.keys()].sort(),
    ["main", "sidebar.panellist"],
    "the sidebar icon and the full-window panel are the only entry points",
  );
  const panelId = registered.get("sidebar.panellist").meta.id;
  assert.equal(
    registered.get("main").meta.key,
    panelId,
    "the sidebar icon and the main panel must share one id, or the click is a no-op",
  );
  assert.equal(typeof registered.get("sidebar.panellist").view, "function");
  const component = registered.get("main").view({});
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
  // ⚠️ 「次调用」随详情列一并移除（那一列是逐行 attempts 展开），不再断言它。
  for (const label of ["流式速度", "整块吞吐", "轮次 / 步数", "轮 ·", "步 ·"])
    assert.ok(decoded.includes(label), "missing label: " + label);
  // 运行日志表不得再有逐行的 step 明细。
  assert.ok(!source.includes("chub-steps"), "per-step list should be gone");
  // JSON 载荷本身仍被使用（模型详情等其它折叠区），不是死代码。
  assert.ok(source.includes("chub-pre"), "detail payload style should stay");
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
  assert.ok(decoded.includes(".chub-axis{display:grid"), "axis must be a grid");
  assert.ok(
    decoded.includes("gridTemplateColumns"),
    "axis must repeat one column per bar",
  );
});

test("package rows show the upstream expiry inline, not only in a hover title", () => {
  // 资源包类渠道（Buddy / WorkBuddy / Qoder / Trae）会下发扣费截止
  // 或到期时间，Gemini 下发窗口重置时刻。原先这些只在悬停 title 里，
  // 用户必须逐行悬停才看得到；现在同时渲染在包标题行上。
  assert.ok(source.includes("chub-pkgwhen"), "missing inline expiry element");
  for (const label of ["到期 ", "周期至 "])
    assert.ok(source.includes(escape(label)), "missing expiry label: " + label);
});

test("the panel fills the window while only the body scrolls", () => {
  // 布局契约：页面本身**不滚动**，概览头与页签常驻，只有内容区滚动。
  // 这与宿主自己的插件管理 / 任务管理页一致，也是「压扁 header」的前提。
  assert.ok(
    /\.chub\{[^}]*height:100%/.test(css),
    "the panel must fill the host main area",
  );
  assert.ok(
    /\.chub\{[^}]*overflow:hidden/.test(css),
    "the page itself must not scroll, otherwise the body's flex height collapses",
  );
  assert.ok(
    /\.chub-body\{[^}]*overflow-y:auto/.test(css),
    "the body is the single scroll container",
  );
  assert.ok(
    /\.chub-body\{[^}]*min-height:0/.test(css),
    "min-height:0 is required for the body scroll to take effect inside a flex column",
  );
  // 设置页那份入口已移除，对应的窄页样式与分支不应残留。
  assert.ok(
    !css.includes(".chub.settings"),
    "the removed settings variant must not leave dead CSS behind",
  );
  assert.ok(
    !css.includes("chub.panel"),
    "there is only one layout now; a .chub.panel variant class is dead weight",
  );
});

test("the overview header stays compact", () => {
  // 用户 2026-10-21 拍板：顶部概览头压扁更好看，内容空间留给下半部分。
  // 实测 2560×1440 下 91px（6.3%）、1280×800 下 87px。
  assert.ok(
    !/\.chub-hero\{[^}]*flex-direction:column;?\s*gap:16px/.test(css),
    "the hero must not keep the old tall stacked spacing",
  );
  assert.ok(
    /\.chub-hero\{[^}]*gap:9px/.test(css),
    "the hero gap must stay tight",
  );
  assert.ok(
    /\.chub-hero\{[^}]*flex:none/.test(css),
    "the hero must not be stretched or shrunk by the flex column",
  );
  // 字数与字号都收了一档。
  assert.ok(
    /\.chub-headline h2\{[^}]*font-size:19px/.test(css),
    "the hero title must be reduced to a compact size",
  );
});

test("wide tables never require horizontal scrolling", () => {
  // 用户明确要求减少横向滚动条。做法：长文本列折行并给最小宽度，
  // 次要列在窄容器里整列隐藏（值仍可在「详情」JSON 里查到）。
  assert.ok(
    /\.chub-scroll td\.wide\{[^}]*min-width:/.test(css),
    "long-text columns need a floor width, or emails wrap one character per line",
  );
  assert.ok(
    /\.chub-scroll td\.nowrap/.test(css),
    "short columns must stay single-line",
  );
  assert.ok(
    /@container chub \(max-width:1400px\)/.test(css),
    "narrow containers must drop secondary columns instead of scrolling sideways",
  );
  assert.ok(
    css.includes("lowpri"),
    "secondary columns need a dedicated class the container query can hide",
  );
  // 整格 `anywhere` 会把单词拆成单字符（1280px 实测），必须是 break-word。
  assert.ok(
    !/\.chub-scroll td\{[^}]*overflow-wrap:anywhere/.test(css),
    "break-word, not anywhere: anywhere splits emails into single characters",
  );
});

test("the log table scrolls inside itself so its horizontal bar stays reachable", () => {
  // 用户 2026-10-21：带侧栏时日志页仍会出现横向滚动条，要求它**一直可见**
  // 可直接拖动，而不是必须先滚到表格最末行。
  // 做法：日志页内容区填满剩余高度，日志面板 flex:1，表格容器自己 overflow。
  assert.ok(
    /\.chub-logs \.chub-logpanel>\.chub-scroll\{[^}]*overflow:auto/.test(css),
    "the log table must own its scrolling so the h-bar sits at the container bottom",
  );
  assert.ok(
    /\.chub-logs \.chub-logpanel\{[^}]*flex:1/.test(css),
    "the log panel must take the remaining height instead of growing with rows",
  );
  assert.ok(
    /\.chub-logs \.chub-logpanel\{[^}]*min-height:0/.test(css),
    "min-height:0 is required for the flex child to actually shrink",
  );
  // 滚动条本身必须常驻可见：Windows 上 Chromium 默认覆盖式会淡出。
  assert.ok(
    /\.chub-scroll\{[^}]*scrollbar-width:auto/.test(css),
    "overlay scrollbars fade out; they must be reserved-width to stay grabbable",
  );
  assert.ok(
    css.includes("::-webkit-scrollbar-thumb"),
    "an explicit thumb keeps the bar visible and draggable",
  );
  assert.ok(
    !/::-webkit-scrollbar[^{]*\{[^}]*display:none/.test(css),
    "hiding the webkit scrollbar removes the only mouse-drag affordance",
  );
});

test("breakpoints follow the container, not the viewport", () => {
  // 分栏必须由**真实可用宽度**决定：宿主的窗口视口可能很宽，而实际内容区
  // 受侧栏、主区域留白等影响会窄不少。视口断点在这种情况下永远不命中，
  // 三列 KPI 与双栏就会在窄容器里硬挤（这正是设置页 564px 里发生过的事）。
  assert.ok(
    css.includes("@container chub"),
    "breakpoints must query the container width",
  );
  assert.ok(
    css.includes("container-type:inline-size"),
    "the container must establish an inline-size query context",
  );
  // 内容分栏不得再出现在视口媒体查询块里（只有容器自身的内边距可以按窗口收窄）。
  const viewportBlocks =
    css.match(/@media \(max-width:[^)]*\)\{[\s\S]*?\n\}/g) ?? [];
  for (const block of viewportBlocks)
    for (const cls of ["chub-channels", "chub-kpis"])
      assert.ok(
        !block.includes(cls),
        `${cls} must not switch columns by viewport width: ${block.slice(0, 80)}`,
      );
});

test("account and model breakdowns stack instead of sharing a row", () => {
  // 用户 2026-10-21 要求：数据看板的「账号透视」与「模型性能」不要并排。
  // 两张表都是 7 列，挤在半宽里模型名与账号名频繁折行。
  assert.ok(
    css.includes(".chub-stack"),
    "the two breakdowns need their own full-width stack container",
  );
  assert.ok(
    !css.includes("chub-grid2"),
    "the old two-column grid must be gone, or the tables come back side by side",
  );
  // 组件里也必须真的用了这个容器类，光有 CSS 不算。
  assert.ok(
    decoded.includes("chub-stack"),
    "the dashboard must actually render the stack container",
  );
});

test("removed detail column leaves no positional side effects", () => {
  // 运行日志的「详情」列已移除。旧的 td:last-child 顶部对齐规则专为那一列而写，
  // 详情列走后它会误伤新的最后一列（缓存命中率），表现为内容不在垂直居中。
  assert.ok(
    !/\.chub-scroll td:last-child\{/.test(css),
    "positional td:last-child styling must not survive the column removal",
  );
  assert.ok(
    /\.chub-scroll td\{[^}]*vertical-align:middle/.test(css),
    "cells must be vertically centered by default",
  );
  assert.ok(
    css.includes("td:has(details)"),
    "only cells that actually hold an expandable block may opt into top alignment",
  );
  // 详情列本身不得留在表头里。
  assert.ok(
    !decoded.includes("3 步 · ") && !decoded.includes("次调用"),
    "the per-row expandable summary must be gone with the column",
  );
});

test("the add-account button sits immediately left of the status pill", () => {
  // 用户 2026-10-29：要求「添加账号」放在「运行中 / 未接入」状态显示的**左侧**。
  //
  // 结构：卡片头右端是一个整体块（`.chub-chanheadend`），内部顺序为
  // 操作 → 状态。整体块一起换行，否则窄卡片里会出现「按钮留在第一行、
  // 徽标被挤到第二行」—— 两者就不挨着了，而「动作紧挨结论」正是这次的效果。
  //
  // 顺序靠 DOM 保证（不用 CSS `order`），否则 Tab 焦点顺序与视觉顺序相反。
  const card = nodes(renderChannelFixture().tree).find(
    (n) => n.props?.className === "chub-channel",
  );
  const head = card?.children.find(
    (n) => n?.props?.className === "chub-chanhead",
  );
  assert.ok(head, "the card must keep a header row");
  const end = head.children.find(
    (n) => n?.props?.className === "chub-chanheadend",
  );
  assert.ok(end, "the header must group the actions with the status pill");
  assert.deepEqual(
    end.children
      .filter((n) => n && typeof n === "object")
      .map((n) => n.props?.className),
    ["chub-chanacts chub-chanheadacts", "chub-chanstate"],
    "the action group must come directly before the status pill",
  );
  assert.match(
    end.children[0].children[0].props.className,
    /chub-btn/,
    "the header action group must actually hold the button",
  );
  assert.ok(
    /\.chub-chanheadend\{[^}]*margin-left:auto/.test(css),
    "an auto margin pushes the action+status block to the right edge",
  );
  assert.ok(
    /\.chub-chanheadend\{[^}]*flex:none/.test(css),
    "the block must not shrink, or the pill detaches from the buttons",
  );
  assert.ok(
    !/\.chub-chanhead\{[^}]*justify-content:space-between/.test(css),
    "space-between would push the buttons away from the status pill",
  );
  // 统计行不再承载按钮：只加 CSS 而 JSX 仍留着旧按钮组会渲染出两个「添加账号」。
  const meta = card?.children.find(
    (n) => n?.props?.className === "chub-chanmeta",
  );
  assert.ok(
    !meta?.children.some((n) => n?.props?.className?.includes("chub-chanheadacts")),
    "the stats row must not carry a second action group",
  );
  assert.equal(
    nodes(renderChannelFixture().tree).filter(
      (n) => n.props?.className === "chub-chanacts chub-chanheadacts",
    ).length,
    1,
    "exactly one action group per card — a leftover copy renders a duplicate button",
  );
});

test("model refresh is a section-level action covering every channel", () => {
  // 用户 2026-10-29：把「更新模型」挪到「旧账号导入」左侧，并改为更新**所有**渠道。
  const tools = nodes(renderChannelFixture().tree).find(
    (n) => n.props?.className === "chub-sectools",
  );
  assert.ok(tools, "the channel section must keep its tool bar");
  const labels = tools.children
    .filter((n) => n?.type === "button")
    .map((n) => n.children[0]);
  assert.deepEqual(
    labels,
    ["更新模型", "旧账号导入"],
    "the refresh button must come before the legacy import button",
  );
  // 逐卡「更新模型」已移除 —— 只留工具条那一枚。
  assert.equal(
    nodes(renderChannelFixture().tree).filter(
      (n) => n?.type === "button" && n.children?.[0] === "更新模型",
    ).length,
    1,
    "the per-channel refresh button must be gone; the tool bar owns it now",
  );
  // 两个按钮必须同一款式：并排时一个有描边一个没有，看起来像两种层级。
  const importBtn = tools.children.filter((n) => n?.type === "button")[1];
  const refreshBtn = tools.children.filter((n) => n?.type === "button")[0];
  assert.equal(
    importBtn.props.className.replace(" chub-btn", ""),
    refreshBtn.props.className.replace(" chub-btn", ""),
    "the legacy import button must use the same border style as refresh",
  );
  assert.ok(
    !importBtn.props.className.includes("ghost"),
    "a transparent border next to a bordered button reads as a different tier",
  );
});


test("multi-account channel cards span two columns and lay their accounts side by side", () => {
  // 用户 2026-10-22：「有的有两个账号、有的单账号留下很多空隙」。
  //
  // 根因不是间距：账号块是纵向列表，多一个账号就多一整块（约 200px），而网格
  // 按行对齐 —— 1440px 实测同排单账号卡下方共 634px 死白，其中 502px 仅来自
  // 「双账号卡与单账号卡同排」。做法是让多账号卡跨两列、账号在卡内并排，
  // 高度差被宽度吸收（见 docs/LAYOUT.md）。
  assert.ok(
    /\.chub-channels\{[^}]*align-items:stretch/.test(css),
    "the grid must stretch rows, or short cards leave the hole below themselves",
  );
  assert.ok(
    /\.chub-channel\[data-multi\]\{[^}]*grid-column:span 2/.test(css),
    "a card with 2+ accounts must span two columns",
  );
  assert.ok(
    /\.chub-channel\[data-multi\]>\.chub-acctlist\{[^}]*display:grid/.test(css),
    "the account list must switch to a grid so accounts sit side by side",
  );
  assert.ok(
    /\.chub-channel\[data-multi\]>\.chub-acctlist\{[^}]*grid-auto-rows:1fr/.test(css),
    "equal row heights keep the action rows of sibling accounts aligned",
  );
  // 卡片要吃满行高，内部的伸缩子项才有空间可分。
  assert.ok(
    /\.chub-channel\{[^}]*height:100%/.test(css),
    "the card itself must fill the stretched row",
  );
  // 组件必须真的输出这个属性 —— 只写 CSS 不会命中任何卡片。
  assert.ok(
    /"data-multi": accounts\.length > 1/.test(decoded),
    "the channel card must emit data-multi when it has more than one account",
  );
});

test("the refresh-all action reports its result and survives the reload", () => {
  // 用户 2026-10-29：「更新模型按钮并不能正常工作」。
  //
  // 实测（真实宿主 + 合成上游）暴露两个缺陷：
  //  ① 没有账号的渠道被计进 `refreshed` —— 9 个渠道只有 1 个有账号时界面
  //     显示「已更新 8/9」，用户点完看不到任何变化，以为按钮坏了；
  //  ② 结果提示写在 `load()` **之前**，而 `load()` 内部会 `setError("")`，
  //     于是刚写进去的失败原因立刻被抹掉 —— 界面一条提示都没有。
  //
  // 这里锁的是**构建产物里的真实实现**（与其它 client 断言同一策略）：
  // 行为本身另由 `artifacts/harness/probe-refresh.mjs` 在真实 Chromium 里点一遍。
  assert.ok(
    decoded.includes("没有可更新的渠道"),
    "a refresh that touched nothing must say so instead of claiming success",
  );
  assert.match(
    decoded,
    /已更新 ["+ ]*refreshed/,
    "the result line must report how many channels really refreshed",
  );
  assert.ok(
    decoded.includes("skipped"),
    "the host reports channels without accounts as skipped; the UI must read it",
  );
  // 文案分档：失败要点名、跳过要计数。
  assert.match(decoded, /失败 /, "failures must be named in the result line");
  assert.match(
    decoded,
    /跳过 ["+ ]*skipped\.length/,
    "skipped channels must be counted separately from failures",
  );
  /**
   * ⚠️ 顺序断言：`await load()` 必须在写结果提示**之前**。
   *
   * 只断言「两句话都在源码里」挡不住这个回归 —— 缺陷正是顺序。这里从
   * `refreshAllModels` 的函数体里取出 `await load()` 与第一次 `setNotice` /
   * `setError` 的位置，要求前者更靠前。
   */
  const body = decoded.slice(
    decoded.indexOf("refreshAllModels = async"),
    decoded.indexOf("const login = async"),
  );
  assert.ok(body.length > 200, "the refresh handler must be locatable");
  const loadAt = body.indexOf("await load()");
  // 函数开头有一句 `setNotice("")` 用于清空上一次的结果，它当然在 load() 之前 ——
  // 要找的是**写入结果**的那一次，用结果文案定位。
  const noticeAt = body.indexOf("没有可更新的渠道");
  assert.ok(loadAt >= 0, "the handler must reload the channel list");
  assert.ok(noticeAt >= 0, "the handler must write a result notice");
  assert.ok(
    loadAt < noticeAt,
    "load() clears the error slot — writing the result before it loses the message",
  );
});

test("single-column layouts reclaim the column span", () => {
  // ⚠️ `grid-column:span 2` 在只有 1 列的网格里会造出**隐式第二列**：卡片只占
  // 半宽、右边留一条等高的白，比原来的洞更糟（780px 实测稳定复现）。
  // 这条兜底不能省，且必须写在容器查询里 —— 判断依据是**真实可用宽度**，
  // 不是视口宽度（带侧栏时两者差很多）。
  const single = css.match(
    /@container chub \(max-width:820px\)\{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(single, "the 820px container query must still exist");
  assert.ok(
    /\.chub-channel\[data-multi\]\{[^}]*grid-column:auto/.test(single),
    "the span must be dropped in the single-column layout",
  );
});

test("stretched cards hand their slack to the account box, not to the card bottom", () => {
  // 行内等高只是把洞从「卡片之间」搬到「卡片内部」。必须再给剩余高度一个去处，
  // 否则卡底就是一块白：
  //  - 账号列表吃掉剩余高度；
  //  - 操作行被推到账号框底边；
  //  - 0 账号渠道的空状态占满剩余高度并居中。
  assert.ok(
    /\.chub-acctlist\{[^}]*flex:1 1 auto/.test(css),
    "the account list must absorb the leftover height",
  );
  assert.ok(
    /\.chub-acctacts\{[^}]*margin-top:auto/.test(css),
    "the action row must sit at the bottom of the account box",
  );
  assert.ok(
    /\.chub-channel>\.chub-empty\{[^}]*flex:1 1 auto/.test(css),
    "the empty state must fill the stretched card instead of leaving a blank band",
  );
});

test("the daily chart legend states the range total", () => {
  // 用户 2026-10-21：柱形是**每天**的量，图例是**整个区间**的合计，两者量级
  // 天然不同，容易被读成「数字对不上」。图例必须以「合计」开头并标明天数。
  assert.ok(
    css.includes(".chub-legendtotal"),
    "the legend needs a dedicated total chip",
  );
  assert.ok(
    decoded.includes("chub-legendtotal"),
    "the legend total must actually be rendered",
  );
  // 合计必须由各渠道合计相加得出：两者不一致时用户按图例相加会对不上。
  assert.match(
    decoded,
    /dailyTotalTokens\s*=\s*\[\.\.\.providerTotals\.values\(\)\]\s*\.reduce/,
    "the grand total must be summed from the per-provider totals",
  );
  // 面板说明必须点明「柱子是每天、图例是区间」。
  assert.ok(
    decoded.includes("柱形是每天各自的量"),
    "the panel hint must explain the two different scopes",
  );
});

test("the log table carries no input/output column any more", () => {
  // 用户 2026-10-21 要求移除日志的「输入 / 输出」列：逐行重复既占宽又不便
  // 横向对比，token 总量仍在概览指标与数据看板里。
  // 只统计**表头字面量**：源码注释里提到列名是说明改动原因，不算残留。
  const header = decoded.match(/const reqTable[\s\S]{0,900}?\]\s*,/);
  assert.ok(header, "reqTable header must be locatable");
  assert.ok(
    !header[0].includes("输入 / 输出"),
    "the input/output column must be gone from the log table header",
  );
  // 其余列仍在，避免误删过头。
  for (const label of ["缓存读 / 写", "缓存命中率", "整块吞吐", "步数"])
    assert.ok(header[0].includes(label), "missing expected column: " + label);
});

test("the stylesheet lives in its own file and is inlined as a string", () => {
  // 结构性修复（2026-10-21）：样式曾是 `client.ts` 里 570 行的模板字面量，
  // 任何出现在 CSS 注释里的反引号都会提前终止字符串 —— 连续踩坑 6 次，
  // 表现是一堆莫名其妙的语法错误。移到 `.css` 后反引号只是普通字符。
  //
  // 这条测试同时锁住三件事，缺一条迁移就会静默失效：
  // 1. 源码里不再有 CSS 模板字面量；
  // 2. 构建产物里**确实**内联了样式（否则页面变无样式）；
  // 3. 没有被抽成独立的 `.css` 资源（esbuild 默认行为，默认导出为空对象）。
  assert.ok(
    !/const css = `/.test(source),
    "the CSS template literal must not come back; move it to client.css",
  );
  assert.ok(css.length > 5000, "client.css should hold the real stylesheet");
  for (const marker of [
    ".chub-hero{",
    "::-webkit-scrollbar-thumb",
    "@container chub",
  ])
    assert.ok(
      source.includes(marker),
      "the built bundle must inline the stylesheet; missing " + marker,
    );
  // 内联意味着产物里没有独立的样式资源。
  assert.ok(
    !/["'.]\/?[A-Za-z0-9_-]*client\.css["']/.test(source),
    "the stylesheet must be inlined, not emitted as a separate asset",
  );
});

/**
 * 从构建产物里取出 `stackHeights`（它在组件工厂内部，无法直接 import）。
 * 用括号计数定位函数体，避免正则被嵌套块骗到。
 */
function extractStackHeights() {
  const start = source.indexOf("function stackHeights");
  assert.ok(start >= 0, "stackHeights must exist in the built client");
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > 0, "stackHeights braces must balance");
  return new Function(
    source.slice(start, end + 1) + "\nreturn stackHeights;",
  )();
}

test("every provider keeps a visible sliver in the daily chart", () => {
  // 真实缺陷（2026-10-21，真实账本）：某天 11 个渠道里前三个占 90%，其余 8 个
  // 按纯比例只有 0.1–1.6px —— 渲染出来看不见。而这张图的目的正是「哪个渠道
  // 在消耗」，占比最小的那些最需要能看见。
  const stackHeights = extractStackHeights();
  const day = [
    229564112, 165414311, 121839748, 24083988, 10655157, 8079710, 5419453,
    4080949, 1773314, 355120, 9765,
  ];
  const BAR = 108;
  const MIN = 2;
  const heights = stackHeights(day, BAR, MIN);

  assert.equal(heights.length, day.length, "one segment per provider");
  // 总高不变 ⇒ 不同日期的柱子仍然可比。这是"抬高小段"不能破坏的硬约束。
  const sum = heights.reduce((n, v) => n + v, 0);
  assert.ok(
    Math.abs(sum - BAR) < 1e-6,
    `stacked height must stay ${BAR}px, got ${sum}`,
  );
  // 每个渠道都留有可见的一笔。
  for (const [i, h] of heights.entries())
    assert.ok(
      h >= MIN - 1e-9,
      `segment ${i} is ${h}px, below the ${MIN}px floor`,
    );
  // 大段可以轻微压缩，但不能压到下限以下、也不能反过来超过比例。
  assert.ok(heights[0] < (day[0] / day.reduce((a, b) => a + b, 0)) * BAR);
  assert.ok(heights[0] > heights[1], "relative order must be preserved");
});

test("stackHeights degrades safely at the edges", () => {
  const stackHeights = extractStackHeights();
  // 单渠道：整根柱都是它。
  assert.deepEqual(stackHeights([100], 108, 2), [108]);
  // 全零或不正的柱高：不画，而不是画出 NaN。
  assert.deepEqual(stackHeights([0, 0], 108, 2), [0, 0]);
  assert.deepEqual(stackHeights([], 108, 2), []);
  assert.deepEqual(stackHeights([1, 2], 0, 2), [0, 0]);
  // 柱高本身放不下所有下限：退化为等高，宁可放弃比例也不让段落消失。
  const tiny = stackHeights([1, 1, 1], 4, 2);
  assert.equal(tiny.length, 3);
  for (const h of tiny) assert.ok(h > 0 && Math.abs(h - 4 / 3) < 1e-9);
});

test("the extended-context switch only renders for channels that declare it", () => {
  // 2026-10-24：Trae 的 Max 档（1M）与常规档计费不同，而目录只下发一个
  // `consumption_rate`。故必须有一个**显式开关**让用户自己选，且开关只出现在
  // 真正有该能力的渠道卡上（其余渠道 `extendedContext` 是 undefined）。
  const withTier = renderChannels([
    {
      id: "trae",
      name: "Trae",
      selectedAccountId: null,
      extendedContext: { supported: true, enabled: false },
      accounts: [],
    },
    { id: "qoder", name: "Qoder", selectedAccountId: null, accounts: [] },
  ]);
  const toggles = nodes(withTier).filter(
    (n) => n.props?.className === "chub-context-toggle",
  );
  assert.equal(toggles.length, 1, "only the channel with the capability gets a toggle");
  const box = nodes(toggles[0]).find((n) => n.type === "input");
  assert.equal(box?.props?.type, "checkbox");
  assert.equal(box?.props?.checked, false);
  // 关闭态必须能打开：payload 里带 provider 与目标状态。
  const onChange = box?.props?.onChange;
  assert.equal(typeof onChange, "function");
  assert.ok(
    /channels\.setExtendedContext/.test(decoded),
    "the toggle must call the dedicated RPC, not models.setDisabled",
  );
});

test("the extended-context switch reflects the persisted state", () => {
  const on = renderChannels([
    {
      id: "trae",
      name: "Trae",
      selectedAccountId: null,
      extendedContext: { supported: true, enabled: true },
      accounts: [],
    },
  ]);
  const box = nodes(on)
    .filter((n) => n.props?.className === "chub-context-toggle")
    .map((n) => nodes(n).find((c) => c.type === "input"))
    .find(Boolean);
  assert.equal(box?.props?.checked, true);
});

test("a model row shows the larger window as a tier badge, dashed when inactive", () => {
  // 徽标只在「目录确实声明了更大一档」时出现；且用 active 区分已开/未开。
  assert.ok(
    /\.chub-tier\{[^}]*border:1px dashed/.test(css),
    "an inactive tier must be visually weaker than an active one",
  );
  assert.ok(
    /\.chub-tier\.on\{[^}]*border-style:solid/.test(css),
    "the active tier must switch to a solid border",
  );
  assert.ok(
    /\.chub-tier\.on\{[^}]*background:/.test(css),
    "the active tier must be filled, not just outlined",
  );
});

test("a Trae off-peak model shows the window in the title, not the chip", () => {
  // Trae 实测最多 4 段窗口；chip 是 `flex:none`，拼进去会撑破模型行。
  // 故 chip 只说「错峰 / 错峰（未生效）」，完整时段进 title。
  const tierChip = (name) => new RegExp("\.chub-" + name + "\{").test(css);
  assert.ok(tierChip("promo"), "the promotion chip exists");
  assert.ok(
    /\.chub-promo\{[^}]*white-space:nowrap/.test(css),
    "the chip must not wrap — that is why the window cannot live there",
  );
  // 文案里带时段的那条分支必须还在（promotionWindow 进 title）。
  assert.ok(
    /promotionWindow/.test(decoded),
    "the window text must still be rendered (in the tooltip)",
  );
});

test("a long account nickname is ellipsized instead of squeezing the stats row", () => {
  // 用户 2026-10-29：长昵称会溢出挤压同一行的其它文字。真实数据是华为码道的
  // `codearts-d6a47740-cb1d-4ac1-80d4-34f8e0efe974`（45 字符）。
  //
  // 1440px 实测的故障形态：统计行**被迫换行**，「账号 1/1」「模型 7」「目录」
  // 被顶到下一行，卡片比同排高出一大截；同时原生 select 的默认
  // `text-overflow:clip` 把文字在字形中间硬切（末字符只剩半个）。
  //
  // 根因不是「下拉框太宽」，而是统计行允许换行 + 旁边还有一行 120px 的
  // 「固定使用，不自动换号」。带那行提示时整行需要 658px，而卡片内容宽最宽
  // 也只有 442px（2400px 视口）—— 提示语在卡片网格里**永远放不下**，于是它
  // 把读数整组顶走。故提示语从标记里移除（含义并入 title），而不是留一段
  // 永不显示的 `display:none` 分支。
  const meta = css.match(/\.chub-chanmeta\{[^}]*\}/)?.[0];
  assert.ok(meta, "the stats row must be locatable");
  assert.match(
    meta,
    /flex-wrap:nowrap/,
    "wrapping is the actual failure mode: the readings get pushed to a second line",
  );
  const choice = css.match(/\.chub-account-choice\{[^}]*\}/)?.[0];
  assert.ok(choice, "the account selector label must be locatable");
  assert.match(
    choice,
    /flex-wrap:nowrap/,
    "wrapping inside the label pushes the stats row down a line",
  );
  assert.match(
    choice,
    /flex:0 1 auto/,
    "the selector must yield width; the readings are non-negotiable",
  );
  const select = css.match(/\.chub-account-choice select\{[^}]*\}/)?.[0];
  assert.ok(select, "the select rules must be locatable");
  assert.match(
    select,
    /text-overflow:ellipsis/,
    "without an ellipsis Chromium hard-clips the text mid-glyph",
  );
  assert.match(
    select,
    /white-space:nowrap/,
    "nowrap is part of the same rule: otherwise the overflow wraps and grows the box",
  );
  assert.match(
    select,
    /overflow:hidden/,
    "ellipsis only renders when overflow is hidden",
  );
  assert.match(
    select,
    /max-width:min\([^)]*100%\)/,
    "the cap must fall back to the container width on narrow cards",
  );
  // 那段提示语不得留在标记里 —— 它是「放不下」的主体。
  assert.ok(
    !/className: "muted"\s*\},\s*"固定使用/.test(decoded),
    "the never-fitting hint must not remain a sibling of the selector",
  );
  const selectNode = nodes(renderChannelFixture().tree).find(
    (n) => n.type === "select",
  );
  assert.equal(
    selectNode?.props?.title,
    "Account B（已停用）\n固定使用，不自动换号",
    "the hint's meaning must survive in the tooltip (b is disabled in the fixture)",
  );
  // 读数项不可压缩：允许收缩会让「账号 N/M」被压成竖排。
  assert.match(
    css,
    /\.chub-chanmeta>b,\.chub-chanmeta>span\{flex:none\}/,
    "the readings must not shrink",
  );
});

test("the account option label is composed once, so tooltip and option agree", () => {
  // 悬停文字与下拉项若各拼一遍，重名尾号 / 停用标记迟早对不上。
  // 夹具里 b 是停用账号，故选中项的文案必须带「（已停用）」。
  const tree = renderChannelFixture("b").tree;
  const select = nodes(tree).find((n) => n.type === "select");
  assert.equal(
    select.props.title,
    "Account B（已停用）\n固定使用，不自动换号",
    "the tooltip carries the full name plus the fixed-account meaning",
  );
  const option = nodes(select).find(
    (n) => n.type === "option" && n.props?.value === "b",
  );
  assert.deepEqual(
    option.children,
    ["Account B（已停用）"],
    "the option itself must not gain the tooltip's second line",
  );
  // 自动选择（无选中项）也要有悬停 —— 它解释的是「不会固定到某一个」，
  // 而这句话原本也由被移除的那行提示承担。
  const auto = nodes(renderChannelFixture(null).tree).find(
    (n) => n.type === "select",
  );
  assert.match(auto.props.title, /自动选择/);
  assert.match(auto.props.title, /不会固定/);
});
