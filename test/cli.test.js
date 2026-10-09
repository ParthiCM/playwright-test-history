"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { parseBuildNumber, escapeHtml, serialiseForScript, renderHtml } = require("../src/triage-report");

const CLI = path.join(__dirname, "..", "src", "triage-report.js");
const TEMPLATE = "<title>__TITLE__</title><script>var D = __DATA__;</script>";

/** Pull the embedded data back out of a rendered page. */
function embedded(html) {
  const m = /var D = ([\s\S]*?);<\/script>/.exec(html);
  assert.ok(m, "data block present");
  return JSON.parse(m[1]);
}

test("parseBuildNumber accepts integers and rejects everything else", () => {
  assert.equal(parseBuildNumber("142"), 142);
  assert.equal(parseBuildNumber(" 7 "), 7);
  assert.equal(parseBuildNumber("0"), 0);
  assert.equal(parseBuildNumber("abc"), null);
  assert.equal(parseBuildNumber("1.5"), null);
  assert.equal(parseBuildNumber("-3"), null);
  assert.equal(parseBuildNumber(""), null);
  assert.equal(parseBuildNumber(true), null, "bare --build flag");
  assert.equal(parseBuildNumber("99999999999999999999"), null, "beyond safe integer range");
});

test("escapeHtml neutralises markup", () => {
  assert.equal(escapeHtml(`<b>"x" & 'y'</b>`), "&lt;b&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/b&gt;");
});

test("renderHtml keeps $ replacement patterns in data literal", () => {
  // Each of these is a special pattern in a String.replace replacement string.
  const data = {
    job: "shop $& $$",
    tests: [{ id: "TC-1", title: "Price is $'10.00' not $`9.99`", sig: "expected $& got $$" }],
  };
  const html = renderHtml(TEMPLATE, data);

  assert.deepEqual(embedded(html), data);
  assert.match(html, /<title>shop \$&amp; \$\$ - test history<\/title>/);
});

test("renderHtml escapes the job name in the title", () => {
  const html = renderHtml(TEMPLATE, { job: "</title><script>alert(1)</script>" });
  assert.ok(!html.includes("<script>alert(1)"), "no injected tag");
  assert.match(html, /&lt;\/title&gt;&lt;script&gt;/);
});

test("serialiseForScript cannot break out of the script element", () => {
  const data = { sig: "</script><!--<script>", line: "a\u2028b\u2029c" };
  const out = serialiseForScript(data);

  assert.ok(!out.includes("<"), "no raw < survives");
  assert.ok(!out.includes("\u2028") && !out.includes("\u2029"));
  assert.deepEqual(JSON.parse(out), data, "still round-trips");
});

/** Run the CLI against a fresh store and return the result. */
function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

test("CLI rejects a non-numeric --build instead of silently losing the build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  const junit = path.join(dir, "results.xml");
  fs.writeFileSync(junit, '<testsuite><testcase name="TC-1 a" classname="a.spec.ts"/></testsuite>');
  const storeDir = path.join(dir, "store");

  try {
    const res = run(["--init", "--store", storeDir, "--out", path.join(dir, "r.html"), "--junit", junit, "--build", "abc"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--build must be a non-negative integer/);
    assert.ok(!fs.readdirSync(storeDir).some((f) => f.includes("NaN")), "no build-0NaN.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI rejects --junit without --build", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-test-"));
  try {
    const res = run(["--init", "--store", dir, "--out", path.join(dir, "r.html"), "--junit", "x.xml"]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /--junit needs --build/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
