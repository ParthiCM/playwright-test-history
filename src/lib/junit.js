"use strict";

/**
 * JUnit XML reader.
 *
 * Playwright's `junit` reporter is the input this project was built around, but
 * the format is the lowest common denominator of test reporting, so most of
 * this works unchanged for other producers.
 *
 * Parsing is done with regular expressions rather than a real XML parser. That
 * is a deliberate trade: it keeps the package at zero dependencies, which
 * matters a lot when the consumer is a Jenkins shell step running on a build
 * agent you do not control. The cost is that it only understands the shape
 * JUnit files actually take, not arbitrary XML. Every assumption it makes is
 * pinned down by a test in `test/junit.test.js`.
 */

const fs = require("fs");

/** Unicode "single right-pointing angle quotation mark" - Playwright's path separator in test names. */
const CHEVRON = "›";

/**
 * Decode the XML entities a JUnit writer can emit, including numeric ones.
 * Playwright escapes the chevron in test names as `&#8250;`, so missing the
 * numeric case quietly breaks test-name splitting.
 *
 * @param {string} s
 * @returns {string}
 */
function unescapeXml(s) {
  return String(s == null ? "" : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Pull the test-case identifier out of a test name.
 *
 * Playwright joins describe blocks and the test title with a chevron, so the
 * id has to be read from the LAST segment. Reading the whole string instead
 * lets a describe block named something like `Checkout TC_2` hijack the id of
 * every test inside it.
 *
 * Supported shapes:
 *   - numeric   `TC-1042` / `TC_1042`
 *   - named     `TC_GuestCheckout`, `TC_Cart_Empty_State`
 *   - none      falls back to the full test name, so nothing is ever dropped
 *
 * @param {string} name Raw `name` attribute of a `<testcase>`.
 * @returns {string|null}
 */
function testIdOf(name) {
  const segment = String(name == null ? "" : name).split(CHEVRON).pop();
  const match = /TC[-_]([A-Za-z0-9]+(?:_[A-Za-z0-9]+)*)/.exec(segment);
  if (match) return "TC-" + match[1];

  const whole = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
  return whole || null;
}

/**
 * Human-readable title: the last name segment with the id and tags stripped.
 * Prefers a quoted title if the convention `TC-1042 @smoke 'Does a thing'` is
 * in use, since that is what the author actually wrote.
 *
 * @param {string} name
 * @returns {string}
 */
function titleOf(name) {
  const segment = String(name == null ? "" : name).split(CHEVRON).pop().trim();

  const quoted = /'([^']+)'|"([^"]+)"/.exec(segment);
  if (quoted) return (quoted[1] || quoted[2]).trim();

  return segment
    .replace(/TC[-_][A-Za-z0-9_]+/g, "")
    .replace(/@[\w-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Suite label for grouping - the spec file's basename, without extension.
 *
 * @param {string} classname `classname` attribute, usually a path.
 * @returns {string}
 */
function suiteOf(classname) {
  const base = String(classname == null ? "" : classname).split(/[\\/]/).pop();
  return base.replace(/\.(spec|test)\.[jt]sx?$/, "").replace(/\.[jt]sx?$/, "");
}

/**
 * Split a JUnit document into its individual `<testcase>` blocks, keeping the
 * full inner XML of each so failure details survive for signature extraction.
 *
 * Handles both self-closing (`<testcase ... />`, a pass) and paired
 * (`<testcase ...> ... </testcase>`) forms.
 *
 * @param {string} xml
 * @returns {Array<{attrs: string, body: string}>}
 */
function splitTestCases(xml) {
  const cases = [];
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    cases.push({ attrs: m[1] || "", body: m[2] === "/>" ? "" : m[3] || "" });
  }
  return cases;
}

/**
 * Read a single attribute out of a tag's attribute string.
 *
 * @param {string} attrs
 * @param {string} key
 * @returns {string}
 */
function attr(attrs, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? unescapeXml(m[1]) : "";
}

/**
 * Decide the outcome of one `<testcase>`.
 *
 * Note the ordering: a test that both failed and was later marked skipped is
 * reported as failed, because the failure is the thing a human needs to see.
 *
 * @param {string} body Inner XML of the testcase.
 * @returns {"F"|"S"|"P"} failed / skipped / passed
 */
function statusOf(body) {
  if (/<(failure|error)\b/.test(body)) return "F";
  if (/<skipped\b/.test(body)) return "S";
  return "P";
}

/**
 * Parse a JUnit XML file into a flat list of test results plus totals.
 *
 * @param {string} file Path to the JUnit XML file.
 * @param {(body: string) => string} signatureFn
 *   Called with a failing testcase's inner XML; returns its failure signature.
 *   Injected so the parser stays independent of how causes are grouped.
 * @returns {{tests: Array<{id: string, title: string, suite: string, status: string, sig: string}>,
 *            totals: {tests: number, passed: number, failures: number, skipped: number}}}
 */
function parseJUnitFile(file, signatureFn) {
  const xml = fs.readFileSync(file, "utf8");
  const tests = [];
  const seen = new Set();

  for (const { attrs, body } of splitTestCases(xml)) {
    const name = attr(attrs, "name");
    const id = testIdOf(name);
    if (!id) continue;

    const status = statusOf(body);

    // A retried test appears more than once. Keep the worst outcome so a test
    // that needed three attempts is not quietly reported as a clean pass.
    if (seen.has(id)) {
      const prior = tests.find((t) => t.id === id);
      if (prior && prior.status !== "F" && status === "F") {
        prior.status = "F";
        prior.sig = signatureFn ? signatureFn(body) : "failed";
      }
      continue;
    }
    seen.add(id);

    tests.push({
      id,
      title: titleOf(name),
      suite: suiteOf(attr(attrs, "classname")),
      status,
      sig: status === "F" && signatureFn ? signatureFn(body) : "",
    });
  }

  const failures = tests.filter((t) => t.status === "F").length;
  const skipped = tests.filter((t) => t.status === "S").length;

  return {
    tests,
    totals: {
      tests: tests.length,
      failures,
      skipped,
      passed: tests.length - failures - skipped,
    },
  };
}

module.exports = {
  CHEVRON,
  unescapeXml,
  testIdOf,
  titleOf,
  suiteOf,
  splitTestCases,
  attr,
  statusOf,
  parseJUnitFile,
};
