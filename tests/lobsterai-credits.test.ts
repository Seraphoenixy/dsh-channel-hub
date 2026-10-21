import test from "node:test";
import assert from "node:assert/strict";
import { fetchLobsteraiCreditBalance } from "../vendor/ofm/src/lobsterai-credits.ts";
import { LOBSTERAI } from "../vendor/ofm/src/lobsterai-product.ts";
import { creditReading } from "../src/core/credits.ts";

// 合成响应，不联网、不读取真实凭据。
async function balanceFor(data: Record<string, unknown>, code = 0) {
  const fetcher = (async () => new Response(JSON.stringify({ code, data }))) as typeof fetch;
  return fetchLobsteraiCreditBalance(
    { access_token: "synthetic-access", refresh_token: "synthetic-refresh" }, LOBSTERAI, fetcher,
  );
}

test("LobsterAI exhausted balance is a successful zero reading, even without packages", async () => {
  for (const total of [0, "0", "0.00", -1]) {
    for (const details of [{}, { creditItems: [] }]) {
      const balance = await balanceFor({ totalCreditsRemaining: total, ...details });
      assert.deepEqual(balance, { total: 0, packages: [], expiredTotal: 0 });
      const reading = creditReading({ at: 123, value: balance });
      assert.equal(reading?.label, "0积分");
      assert.equal(reading?.error, undefined);
    }
  }
});

test("LobsterAI missing or invalid totals remain failures without package evidence", async () => {
  for (const total of [undefined, null, "", " ", "invalid", true, {}, []]) {
    assert.equal(await balanceFor({ totalCreditsRemaining: total, creditItems: [] }), null);
  }
  assert.equal(await balanceFor({ totalCreditsRemaining: 0 }, 401), null);
});
