/** Pin an unstarted ordinary session before another session changes the default. */
export function installSessionModelIsolation(ctx: any) {
  ctx.on("agent/created", ({ agent }: any) => {
    const session = agent.session;
    if (session.header?.origin === "subagent" || session.header?.parentSession) return;
    const projections = ctx.get?.("sessionProjections");
    const defaults = ctx.get?.("agentDefaultModel");
    const state = projections?.stateOf(session, "modelSelection");
    if (!defaults || !state || state.pending != null || session.requestHeader()) return;
    const initial = { ...defaults.currentSelection() };
    if (!initial.provider || !initial.model) return;
    session.append("model/selection", initial);

    // The host installed its selection getter before agent/created. Until the
    // first header exists, that getter still falls back to the live default.
    // Read the durable pending selection so an explicit later pick wins, and
    // snapshot before awaiting assembly just as the host does.
    let assembled: any;
    const offAssembly = agent.ctx.on("system-prompt/assemble", async (assembly: any, context: any, next: any) => {
      const pending = projections.stateOf(session, "modelSelection")?.pending;
      const selected = !session.requestHeader() && pending != null ? { ...pending } : undefined;
      const result = await next();
      assembled = selected;
      return selected ? {
        ...result,
        variables: { ...result.variables, provider: selected.provider, model: selected.model },
      } : result;
    }, { prepend: true });
    const offRequest = agent.ctx.on("agent/request", async (_payload: any, next: any) => {
      const result = await next();
      if (!assembled) return result;
      const { reasoningEffort: _effort, ...rest } = result;
      return { ...rest, ...assembled };
    }, { prepend: true });
    // 清理必须挂在**会话自己的 scope** 上：挂在插件 scope 的 effect 每条
    // 会话累积一条、直到插件卸载才执行，闭包经 offAssembly/offRequest 持有
    // 整个 session —— 内存随会话数单调增长（真实缺陷，2026-11-08 审查发现）。
    // 会话 scope 结束（或插件卸载级联 dispose 子 scope）时清理，两个时机都覆盖。
    const cleanup = () => { offAssembly(); offRequest(); };
    if (typeof agent.ctx.effect === "function") agent.ctx.effect(() => cleanup);
    else ctx.effect(() => cleanup);
  });
}
