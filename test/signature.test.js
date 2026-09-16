"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  failureText,
  errorLine,
  projectFrame,
  normalise,
  signatureOf,
  splitSignature,
  clusterFailures,
} = require("../src/lib/signature");

test("failureText reads the failure element, never system-out", () => {
  // The defect this guards against: reading the first CDATA anywhere inside
  // <testcase> picks up a timestamped log line from <system-out>. Every
  // failure then gets a unique signature, every group has one member, and the
  // root-cause table becomes useless - the exact opposite of its purpose.
  const body = `
    <system-out><![CDATA[2026-03-11 09:14:02 [INFO] : starting TC-1
2026-03-11 09:14:09 [INFO] : clicking submit]]></system-out>
    <failure message="boom" type="FAILURE"><![CDATA[
    locator.click: Timeout 30000ms exceeded.
        at src/pages/checkout.page.ts:118
]]></failure>
  `;
  const text = failureText(body);
  assert.match(text, /locator\.click/);
  assert.doesNotMatch(text, /\[INFO\]/);
});

test("failureText copes with a message-only failure and with no failure", () => {
  assert.equal(failureText('<failure message="it broke"/>'), "it broke");
  assert.equal(failureText("<skipped/>"), "");
  assert.equal(failureText(""), "");
});

test("errorLine skips logger lines and stack noise", () => {
  const text = [
    "2026-03-11 09:14:02 [INFO] : starting",
    "[WARN] : retrying",
    "   ",
    "    at src/pages/a.page.ts:1",
    "Error: the real problem",
  ].join("\n");
  assert.equal(errorLine(text), "Error: the real problem");
});

test("projectFrame picks the deepest frame in your own code, not the framework", () => {
  const text = [
    "locator.click: Timeout 30000ms exceeded.",
    "    at src/pages/checkout.page.ts:118",
    "    at src/tests/checkout.spec.ts:42",
    "    at node_modules/@playwright/test/lib/worker.js:210",
  ].join("\n");
  assert.equal(projectFrame(text), "src/pages/checkout.page.ts:118");
  assert.equal(projectFrame(text, "nope"), "");
});

test("projectFrame honours a custom source root", () => {
  const text = "boom\n    at app/pages/cart.page.ts:64";
  assert.equal(projectFrame(text, "app"), "app/pages/cart.page.ts:64");
});

test("normalise removes values that change on every run", () => {
  // Without this, two runs of the same defect never group together.
  const a = normalise("Timeout 30000ms exceeded at 2026-03-11T09:14:02Z id 6f1c2b7e-1a4d-4f1e-9c2b-77a0a2f0b5d1");
  const b = normalise("Timeout 30000ms exceeded at 2026-03-12T11:02:44Z id 11112222-3333-4444-5555-666677778888");
  assert.equal(a, b);
});

test("signatureOf pairs the error with the location", () => {
  const body = `<failure message="m"><![CDATA[
    locator.click: Timeout 30000ms exceeded.
        at src/pages/checkout.page.ts:118
]]></failure>`;
  const sig = signatureOf(body, "src");
  const { error, location } = splitSignature(sig);
  assert.equal(location, "src/pages/checkout.page.ts:118");
  assert.match(error, /locator\.click/);
});

test("signatureOf is stable across runs of the same defect", () => {
  const make = (stamp, ms) => `<failure message="m"><![CDATA[
    ${stamp} [INFO] : noise
    locator.click: Timeout ${ms}ms exceeded.
        at src/pages/checkout.page.ts:118
]]></failure>`;
  assert.equal(
    signatureOf(make("2026-03-11 09:14:02", 30000), "src"),
    signatureOf(make("2026-03-19 22:41:55", 30000), "src"),
  );
});

test("signatureOf degrades to 'failed' rather than throwing", () => {
  assert.equal(signatureOf(""), "failed");
  assert.equal(signatureOf("<skipped/>"), "failed");
});

test("clusterFailures groups by signature, largest cause first", () => {
  const tests = [
    { id: "TC-1", status: "F", sig: "boom  @  src/a.ts:1" },
    { id: "TC-2", status: "F", sig: "boom  @  src/a.ts:1" },
    { id: "TC-3", status: "F", sig: "boom  @  src/a.ts:1" },
    { id: "TC-4", status: "F", sig: "other  @  src/b.ts:9" },
    { id: "TC-5", status: "P", sig: "" },
    { id: "TC-6", status: "S", sig: "" },
  ];

  const clusters = clusterFailures(tests);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 3);
  assert.deepEqual(clusters[0].ids, ["TC-1", "TC-2", "TC-3"]);
  assert.equal(clusters[0].location, "src/a.ts:1");
  assert.equal(clusters[1].count, 1);

  // Passing and skipped tests never appear in the cause table.
  const all = clusters.flatMap((c) => c.ids);
  assert.ok(!all.includes("TC-5"));
  assert.ok(!all.includes("TC-6"));
});

test("clusterFailures returns nothing when the suite is green", () => {
  assert.deepEqual(clusterFailures([{ id: "TC-1", status: "P", sig: "" }]), []);
});

test("the same defect across many tests collapses to one row", () => {
  // The whole value proposition, asserted: 12 red tests, 2 things to fix.
  const body = (frame) => `<failure message="m"><![CDATA[
    locator.click: Timeout 30000ms exceeded.
        at ${frame}
]]></failure>`;

  const tests = [];
  for (let i = 0; i < 8; i++) tests.push({ id: "TC-" + i, status: "F", sig: signatureOf(body("src/pages/a.page.ts:10"), "src") });
  for (let i = 8; i < 12; i++) tests.push({ id: "TC-" + i, status: "F", sig: signatureOf(body("src/pages/b.page.ts:22"), "src") });

  const clusters = clusterFailures(tests);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].count, 8);
  assert.equal(clusters[1].count, 4);
});
