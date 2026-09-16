"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { testIdOf, titleOf, suiteOf, statusOf, unescapeXml, splitTestCases, parseJUnitFile } = require("../src/lib/junit");
const { signatureOf } = require("../src/lib/signature");

const CHEVRON = "›";

test("unescapeXml decodes named and numeric entities", () => {
  assert.equal(unescapeXml("a &amp; b"), "a & b");
  assert.equal(unescapeXml("&lt;tag&gt;"), "<tag>");
  assert.equal(unescapeXml("&quot;q&quot; &apos;a&apos;"), '"q" \'a\'');
  // Playwright writes the chevron in test names as a numeric entity. Missing
  // this case silently breaks every name split downstream.
  assert.equal(unescapeXml("A &#8250; B"), "A " + CHEVRON + " B");
  assert.equal(unescapeXml("A &#x203a; B"), "A " + CHEVRON + " B");
});

test("testIdOf reads the id from the LAST name segment, not a describe prefix", () => {
  // A describe block whose own name contains a TC id must not hijack the id
  // of every test inside it - this was a real defect.
  const name = `Suite TC_2 ${CHEVRON} sub ${CHEVRON} TC-1042 @e2e 'Does a thing'`;
  assert.equal(testIdOf(name), "TC-1042");
});

test("testIdOf supports numeric, underscore and named ids", () => {
  assert.equal(testIdOf("TC-1042 'x'"), "TC-1042");
  assert.equal(testIdOf("TC_1042 'x'"), "TC-1042");
  assert.equal(testIdOf("TC_GuestCheckout @tag 'x'"), "TC-GuestCheckout");
  assert.equal(testIdOf("@TC_Cart_Empty_State 'x'"), "TC-Cart_Empty_State");
});

test("testIdOf falls back to the full name so no test is ever dropped", () => {
  assert.equal(testIdOf("just a plain test name"), "just a plain test name");
  assert.equal(testIdOf("  spaced   out  "), "spaced out");
  assert.equal(testIdOf(""), null);
  assert.equal(testIdOf(null), null);
});

test("titleOf prefers the quoted title, else strips id and tags", () => {
  assert.equal(titleOf(`x ${CHEVRON} TC-1042 @e2e 'Signs the user in'`), "Signs the user in");
  assert.equal(titleOf('TC-1042 @e2e "Double quoted"'), "Double quoted");
  assert.equal(titleOf("TC-1042 @e2e @slow Unquoted title here"), "Unquoted title here");
});

test("suiteOf reduces a classname path to a bare spec name", () => {
  assert.equal(suiteOf("src/tests/checkout.spec.ts"), "checkout");
  assert.equal(suiteOf("src\\tests\\cart.test.js"), "cart");
  assert.equal(suiteOf("account.ts"), "account");
  assert.equal(suiteOf(""), "");
});

test("splitTestCases handles both self-closing and paired testcases", () => {
  const xml = `
    <testcase name="a" classname="c.ts" time="1"/>
    <testcase name="b" classname="c.ts" time="1"><failure message="m">boom</failure></testcase>
  `;
  const cases = splitTestCases(xml);
  assert.equal(cases.length, 2);
  assert.equal(cases[0].body, "");
  assert.match(cases[1].body, /failure/);
});

test("statusOf ranks failure above skipped", () => {
  assert.equal(statusOf(""), "P");
  assert.equal(statusOf("<skipped/>"), "S");
  assert.equal(statusOf('<failure message="m">x</failure>'), "F");
  // A test that failed and was then marked skipped is still a failure to a human.
  assert.equal(statusOf('<failure message="m">x</failure><skipped/>'), "F");
});

/** Write a JUnit document to a temp file and parse it. */
function parseXml(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "junit-test-"));
  const file = path.join(dir, "results.xml");
  fs.writeFileSync(file, xml);
  try {
    return parseJUnitFile(file, (body) => signatureOf(body, "src"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parseJUnitFile produces tests and totals that agree with each other", () => {
  const { tests, totals } = parseXml(`<?xml version="1.0"?>
<testsuites>
  <testsuite name="s">
    <testcase name="TC-1 'passes'" classname="src/tests/a.spec.ts" time="1"/>
    <testcase name="TC-2 'skips'" classname="src/tests/a.spec.ts" time="1"><skipped/></testcase>
    <testcase name="TC-3 'fails'" classname="src/tests/b.spec.ts" time="1">
      <failure message="boom" type="FAILURE"><![CDATA[
    Error: boom
        at src/pages/a.page.ts:12
]]></failure>
    </testcase>
  </testsuite>
</testsuites>`);

  assert.equal(tests.length, 3);
  assert.deepEqual(totals, { tests: 3, failures: 1, skipped: 1, passed: 1 });
  assert.equal(totals.passed + totals.failures + totals.skipped, totals.tests);

  const failed = tests.find((t) => t.id === "TC-3");
  assert.equal(failed.status, "F");
  assert.equal(failed.suite, "b");
  assert.match(failed.sig, /src\/pages\/a\.page\.ts:12/);
});

test("a retried test keeps its worst outcome", () => {
  // Playwright emits one <testcase> per attempt. Reporting the final green
  // attempt would hide a test that needed three tries to pass.
  const { tests, totals } = parseXml(`<testsuites><testsuite name="s">
    <testcase name="TC-9 'flaky'" classname="src/tests/a.spec.ts" time="1"/>
    <testcase name="TC-9 'flaky'" classname="src/tests/a.spec.ts" time="1">
      <failure message="boom"><![CDATA[Error: boom
        at src/pages/a.page.ts:5]]></failure>
    </testcase>
  </testsuite></testsuites>`);

  assert.equal(tests.length, 1, "attempts collapse to one row");
  assert.equal(tests[0].status, "F");
  assert.equal(totals.failures, 1);
});

test("tests with no id are kept, keyed on their full name", () => {
  const { tests } = parseXml(`<testsuites><testsuite name="s">
    <testcase name="an unlabelled test" classname="src/tests/a.spec.ts" time="1"/>
  </testsuite></testsuites>`);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].id, "an unlabelled test");
});
