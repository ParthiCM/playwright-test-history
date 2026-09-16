"use strict";

/**
 * Failure-signature extraction and clustering.
 *
 * This is the part that turns "40 tests are red" into "you have 5 bugs".
 *
 * A signature is `<normalised error message> @ <deepest project stack frame>`.
 * Two tests that fail with the same message in the same place are almost
 * always the same defect, so grouping on that pair collapses a wall of red
 * into a short list of things to actually fix.
 *
 * The grouping is mechanical, not clever. It tells you WHICH tests share a
 * cause; it does not tell you WHY. That judgement stays with the human, and
 * the report says so.
 */

const { unescapeXml } = require("./junit");

/**
 * Lines a logger writes that look like errors but are not the failure.
 * Suites that log `[INFO] : ...` produce these in the thousands.
 */
const LOGGER_LINE = /^\s*(?:\[?\d{1,4}[-/:]\d{1,2}[-/:]\d{1,4}\b.*)?\[(?:INFO|WARN|ERROR|DEBUG|TRACE)\]/i;

/** Noise that carries no grouping value. */
const NOISE_LINE = /^\s*(?:at\s|Error:\s*$|={3,}|-{3,}|\s*$)/;

/**
 * Values that differ on every run and so must not reach the signature, or
 * every failure becomes its own group.
 */
const VOLATILE = [
  [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, "<timestamp>"],
  [/\b\d{1,2}:\d{2}:\d{2}\s*(?:AM|PM)?\b/gi, "<time>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\bTimeout\s+\d+ms\b/gi, "Timeout <n>ms"],
  [/\b\d+ms\b/g, "<n>ms"],
  [/\b0x[0-9a-f]+\b/gi, "<addr>"],
  [/:\d+:\d+\)/g, ")"],
];

/**
 * Extract the text of a testcase's failure, ignoring everything else.
 *
 * This scoping is the single most important line in the file. An earlier
 * version read the first CDATA block anywhere inside `<testcase>`, which on a
 * suite that logs to stdout picked up a timestamped line from `<system-out>`
 * instead of the error. Every failure then carried a unique timestamp, every
 * signature was unique, and the root-cause table degenerated into one row per
 * test - the exact opposite of what it exists to do.
 *
 * @param {string} body Inner XML of a `<testcase>`.
 * @returns {string} The failure text, or "" if the testcase did not fail.
 */
function failureText(body) {
  const element = /<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/.exec(body);
  if (!element) {
    // A failure can also be recorded purely as a message attribute.
    const bare = /<(failure|error)\b([^>]*)\/>/.exec(body);
    if (!bare) return "";
    const msg = /\bmessage\s*=\s*"([^"]*)"/.exec(bare[2] || "");
    return msg ? unescapeXml(msg[1]) : "";
  }

  const cdata = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(element[2]);
  return cdata ? cdata[1] : unescapeXml(element[2]);
}

/**
 * First line of the failure text that is an actual error and not log noise.
 *
 * @param {string} text
 * @returns {string}
 */
function errorLine(text) {
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (LOGGER_LINE.test(line)) continue;
    if (NOISE_LINE.test(line)) continue;
    return line;
  }
  return "";
}

/**
 * The deepest stack frame that points at the project's own code.
 *
 * Framework frames are useless for grouping - every Playwright timeout shares
 * them. The first `src/...` frame is where the team's own code gave up, which
 * is where the fix will go.
 *
 * @param {string} text
 * @param {string} [root="src"] Top-level directory of the project's own code.
 * @returns {string}
 */
function projectFrame(text, root) {
  const dir = root || "src";
  const re = new RegExp(`(${dir}[\\\\/][^\\s):]+\\.[jt]sx?:\\d+)`, "g");
  const frames = String(text || "").match(re);
  return frames && frames.length ? frames[0].replace(/\\/g, "/") : "";
}

/**
 * Strip run-specific values so the same defect produces the same string twice.
 *
 * @param {string} line
 * @returns {string}
 */
function normalise(line) {
  let out = String(line || "");
  for (const [re, replacement] of VOLATILE) out = out.replace(re, replacement);
  return out.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Build the signature for one failing testcase.
 *
 * @param {string} body Inner XML of a `<testcase>`.
 * @param {string} [root="src"] Top-level directory of the project's own code.
 * @returns {string}
 */
function signatureOf(body, root) {
  const text = failureText(body);
  if (!text) return "failed";

  const message = normalise(errorLine(text));
  const frame = projectFrame(text, root);

  if (!message && !frame) return "failed";
  if (!frame) return message;
  if (!message) return "failed  @  " + frame;
  return message + "  @  " + frame;
}

/**
 * Split a signature back into its two halves for display.
 *
 * @param {string} sig
 * @returns {{error: string, location: string}}
 */
function splitSignature(sig) {
  const parts = String(sig || "").split("  @  ");
  return { error: parts[0] || "failed", location: parts[1] || "" };
}

/**
 * Group the currently-failing tests by signature, biggest cause first.
 *
 * @param {Array<{id: string, title: string, sig: string, status: string}>} tests
 * @returns {Array<{sig: string, error: string, location: string, ids: string[], count: number}>}
 */
function clusterFailures(tests) {
  const groups = new Map();

  for (const t of tests) {
    if (t.status !== "F") continue;
    const sig = t.sig || "failed";
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(t.id);
  }

  return [...groups.entries()]
    .map(([sig, ids]) => {
      const { error, location } = splitSignature(sig);
      return { sig, error, location, ids, count: ids.length };
    })
    .sort((a, b) => b.count - a.count || a.error.localeCompare(b.error));
}

module.exports = {
  failureText,
  errorLine,
  projectFrame,
  normalise,
  signatureOf,
  splitSignature,
  clusterFailures,
};
