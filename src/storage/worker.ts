import { parentPort, workerData } from "node:worker_threads";
import { LedgerDatabase } from "./database.ts";
const db = new LedgerDatabase(workerData.file);
parentPort!.on("message", ({ id, method, args }) => {
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
      "close",
    ];
    if (!allowed.includes(method)) throw Error("Unknown database operation");
    const result = (db as any)[method](...args);
    parentPort!.postMessage({ id, result });
  } catch (error) {
    parentPort!.postMessage({ id, error: String(error) });
  }
});
parentPort!.postMessage({ ready: true });
