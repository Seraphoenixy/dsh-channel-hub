export function createDrivers(ctx: any, services: any): Promise<any>;
/** DSH 调用上下文 → 轮次信息（`sessionId` + 是否开启新一轮）。 */
export function streamMeta(opts: any): { sessionId?: string; startsTurn: boolean };
