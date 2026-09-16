"use strict";

/**
 * The build-history store.
 *
 * The whole project exists because of one property of CI servers: build
 * records are rotated. Jenkins' default `numToKeep` is small, and every
 * per-build report - Playwright HTML, Allure, JUnit - dies with the build that
 * produced it. Ask "has this test ever passed?" and the evidence is usually
 * already deleted.
 *
 * So results are written OUTSIDE the build record, into a directory the CI
 * server does not own and never rotates, as one immutable JSON file per build:
 *
 *     <store>/build-0042.json
 *
 * Three properties fall out of that shape, and all three matter:
 *
 *   - Immutable. A crashed or half-finished build cannot corrupt history,
 *     because it only ever writes its own file.
 *   - Idempotent. Re-running build 42 replaces build 42 and nothing else.
 *   - Cheap. Roughly 10-15 KB per build; a thousand builds is a few megabytes.
 */

const fs = require("fs");
const path = require("path");

/** Build numbers are zero-padded so a plain directory listing sorts correctly. */
const PAD = 4;

/**
 * @param {number|string} n
 * @returns {string} e.g. "build-0042.json"
 */
function fileNameFor(n) {
  return `build-${String(n).padStart(PAD, "0")}.json`;
}

/**
 * @param {string} dir
 * @returns {boolean}
 */
function storeExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Create the store directory.
 *
 * Deliberately NOT called automatically. After the first run, a missing store
 * means something is wrong - most often that the job is running on an agent
 * where the volume holding the history is not mounted. Silently recreating it
 * there would start a brand-new empty history and throw away everything, and
 * nobody would notice until they went looking for a trend that no longer
 * existed. Failing loudly is the correct behaviour; `--init` is the one-time
 * opt-in for the very first run.
 *
 * @param {string} dir
 */
function initStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Write one build's results. Overwrites only that build's own file.
 *
 * @param {string} dir
 * @param {object} record
 * @returns {string} Path written.
 */
function writeBuild(dir, record) {
  const dest = path.join(dir, fileNameFor(record.build));
  fs.writeFileSync(dest, JSON.stringify(record));
  return dest;
}

/**
 * Read every build record, oldest first. Unreadable files are skipped rather
 * than fatal - one corrupt file should not take the whole report down.
 *
 * @param {string} dir
 * @returns {object[]}
 */
function readStore(dir) {
  if (!storeExists(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter((f) => /^build-\d+\.json$/.test(f))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((r) => r && typeof r.build === "number")
    .sort((a, b) => a.build - b.build);
}

/**
 * How many times an outcome sequence flipped between pass and fail.
 * Two or more flips is the working definition of "flaky" in the report.
 *
 * @param {string[]} seq Statuses in build order; "-" and "S" are ignored.
 * @returns {number}
 */
function countFlips(seq) {
  let flips = 0;
  let last = null;
  for (const s of seq) {
    if (s !== "P" && s !== "F") continue;
    if (last !== null && s !== last) flips++;
    last = s;
  }
  return flips;
}

/**
 * The build number at which the current unbroken failing run began.
 * Returns null when the test is not currently failing.
 *
 * @param {string[]} seq Statuses in build order.
 * @param {number[]} numbers Build numbers, same length as seq.
 * @returns {number|null}
 */
function failingSince(seq, numbers) {
  let i = seq.length - 1;
  while (i >= 0 && (seq[i] === "-" || seq[i] === "S")) i--;
  if (i < 0 || seq[i] !== "F") return null;

  let start = numbers[i];
  for (let j = i; j >= 0; j--) {
    if (seq[j] === "F") start = numbers[j];
    else if (seq[j] === "P") break;
  }
  return start;
}

/**
 * Fold the per-build records into the single object the HTML template renders.
 *
 * Every test ever seen becomes one row; builds it did not appear in are marked
 * "-" rather than assumed passed. That distinction is what lets the report be
 * honest about tests that were added, renamed or deleted mid-history.
 *
 * @param {object[]} builds Records from readStore(), oldest first.
 * @param {(tests: object[]) => object[]} clusterFn Failure-clustering function.
 * @returns {{builds: object[], tests: object[], clusters: object[]}}
 */
function buildMatrix(builds, clusterFn) {
  const numbers = builds.map((b) => b.build);

  const meta = new Map();
  for (const b of builds) {
    for (const t of b.tests || []) {
      if (!meta.has(t.id)) meta.set(t.id, { title: t.title || "", suite: t.suite || "" });
      else {
        // Later builds win - a renamed test should show its current name.
        const m = meta.get(t.id);
        if (t.title) m.title = t.title;
        if (t.suite) m.suite = t.suite;
      }
    }
  }

  const byBuild = builds.map((b) => {
    const map = new Map();
    for (const t of b.tests || []) map.set(t.id, t);
    return map;
  });

  const tests = [...meta.keys()].map((id) => {
    const seq = byBuild.map((m) => (m.has(id) ? m.get(id).status : "-"));
    const executed = seq.filter((s) => s === "P" || s === "F");
    const passed = executed.filter((s) => s === "P").length;

    return {
      id,
      title: meta.get(id).title,
      suite: meta.get(id).suite,
      s: seq,
      runs: executed.length,
      passed,
      flips: countFlips(seq),
      since: failingSince(seq, numbers),
    };
  });

  // Currently failing first, then flakiest, then alphabetical - so the rows a
  // reader needs are at the top before they touch a single filter.
  const lastIndex = builds.length - 1;
  tests.sort((a, b) => {
    const af = a.s[lastIndex] === "F" ? 0 : 1;
    const bf = b.s[lastIndex] === "F" ? 0 : 1;
    if (af !== bf) return af - bf;
    if (a.flips !== b.flips) return b.flips - a.flips;
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  });

  const latest = builds[builds.length - 1];
  const latestTests = latest ? latest.tests || [] : [];

  return {
    builds: builds.map((b) => ({
      n: b.build,
      branch: b.branch || "",
      env: b.env || "",
      url: b.url || "",
      date: b.date || "",
      t: (b.totals && b.totals.tests) || 0,
      p: (b.totals && b.totals.passed) || 0,
      f: (b.totals && b.totals.failures) || 0,
      s: (b.totals && b.totals.skipped) || 0,
    })),
    tests,
    clusters: clusterFn ? clusterFn(latestTests) : [],
  };
}

module.exports = {
  PAD,
  fileNameFor,
  storeExists,
  initStore,
  writeBuild,
  readStore,
  countFlips,
  failingSince,
  buildMatrix,
};
