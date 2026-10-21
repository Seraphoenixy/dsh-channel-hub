/**
 * 让 TypeScript 接受把 CSS 当成**字符串**导入。
 *
 * ⚠️ 这不是"随便加个声明"：本包的浏览器入口曾经把整份样式写成
 * `const css = \`…\`` 模板字面量，而那段 CSS 有 570 行。任何出现在 CSS
 * 注释里的反引号都会**提前终止字符串**，表现为一堆莫名其妙的语法错误
 * （真实踩坑：2026-10-21 连续 6 次）。把样式移到 `client.css`、由 esbuild
 * 的 `text` loader 内联成字符串后，反引号在 CSS 里就只是普通字符。
 *
 * 构建侧对应 `scripts/build.mjs` 里 client 入口的
 * `loader: { ".css": "text" }`；两处必须同时存在，否则导入会变成
 * "打包成 CSS 资源"而不是字符串。
 */
declare module "*.css" {
  const text: string;
  export default text;
}
