import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGeminiCatalog,
  discoverGemini,
} from "../src/drivers/gemini-catalog.ts";
test("Gemini advertises only remotely confirmed models supported by existing inference driver", () => {
  assert.deepEqual(
    parseGeminiCatalog(
      { models: { other: { displayName: "Other" } } },
      "supported",
    ),
    [],
  );
  const models = parseGeminiCatalog(
    {
      models: {
        "supported-high": { displayName: "High" },
        "supported-low": {},
        unknown: {},
      },
    },
    "supported",
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "supported");
  assert.deepEqual(models[0].effortOptions, ["high", "low"]);
  assert.equal(models[0].contextWindow, undefined);
});
test("Gemini malformed response is failure; successful empty directory is removal", () => {
  assert.throws(() => parseGeminiCatalog({}, "supported"), /models/);
  assert.deepEqual(parseGeminiCatalog({ models: {} }, "supported"), []);
});
test("Gemini discovery tries known endpoints and forwards supplied auth headers", async () => {
  let calls = 0;
  const models = await discoverGemini({
    credential: { project: "test-project" },
    headers: new Headers({ Authorization: "Bearer fixture" }),
    endpoints: ["https://first.test", "https://second.test"],
    supportedId: "supported",
    fetcher: async (input, init) => {
      calls++;
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer fixture",
      );
      assert.equal(JSON.parse(String(init?.body)).project, "test-project");
      return calls === 1
        ? new Response("", { status: 503 })
        : Response.json({ models: { supported: { displayName: "Dynamic" } } });
    },
  });
  assert.equal(calls, 2);
  assert.equal(models[0].name, "Dynamic");
});
