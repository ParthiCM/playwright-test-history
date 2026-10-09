#!/usr/bin/env node
"use strict";

/**
 * playwright-test-triage
 *
 * Reads a Playwright JUnit results file, appends it to a durable build-history
 * store, and renders a single self-contained HTML page showing every test
 * across every build plus the current failures grouped by root cause.
 *
 * Zero dependencies, on purpose: the usual consumer is a shell step on a build
 * agent, where `npm install` of a reporting tool is one more thing to break.
 *
 * Run `node src/triage-report.js --help` for usage.
 */

const fs = require("fs");
const path = require("path");

const { parseJUnitFile } = require("./lib/junit");
const { signatureOf, clusterFailures } = require("./lib/signature");
const { envOf } = require("./lib/env");
const store = require("./lib/store");

const TEMPLATE = path.join(__dirname, "template", "report-template.html");
const PREFIX = "triage-report:";

/**
 * Parse `--flag value` and `--flag` argv into an object.
 *
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Validate a `--build` value.
 *
 * `Number("abc")` is NaN, which used to be written as `build-0NaN.json` - a
 * file `readStore` never matches, so the build vanished without an error.
 *
 * @param {string|boolean} value
 * @returns {number|null} The build number, or null if it is not a valid one.
 */
function parseBuildNumber(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Escape text for an HTML text node. Used for the page `<title>`, where the
 * job name lands before any template script has a chance to escape it.
 *
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * Serialise data for embedding in an inline `<script>`.
 *
 * Escaping every `<` (not just `</`) also closes off `<!--` and `<script`
 * sequences, which change how the HTML parser tokenises script content.
 * U+2028/U+2029 are escaped for older JS engines that reject them in source.
 *
 * @param {object} data
 * @returns {string}
 */
function serialiseForScript(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Fill the report template.
 *
 * Replacements are passed as functions, not strings. A replacement string
 * gives `$&`, `$'`, `` $` `` and `$$` special meaning, so a failure message
 * such as "expected $'10.00'" used to splice parts of the template into the
 * embedded JSON and produce a page that would not load.
 *
 * @param {string} template
 * @param {object} data
 * @returns {string}
 */
function renderHtml(template, data) {
  const title = escapeHtml(`${data.job} - test history`);
  const json = serialiseForScript(data);
  return template.replace("__TITLE__", () => title).replace("__DATA__", () => json);
}

const HELP = `
playwright-test-triage - cross-build test history and failure triage

  node src/triage-report.js --store <dir> --out <file.html> [options]

Required
  --store <dir>     Directory holding one JSON file per build. Must live
                    OUTSIDE the CI workspace so it survives build rotation
                    and workspace cleanup.
  --out <file>      Where to write the HTML report.

Recording a build (omit all three to re-render from existing history)
  --junit <file>    Path to the JUnit XML, e.g. playwright-report/results.xml
  --build <number>  Build number. Required alongside --junit.
  --init            FIRST RUN ONLY. Creates the store if it is missing.
                    Remove it afterwards - see the note below.

Metadata shown in the report
  --branch <name>   Branch the suite ran from.
  --env <url|name>  Environment the suite ran against. A URL is fine; it is
                    normalised to dev / staging / prod.
  --url <url>       Link back to the CI build.
  --job <name>      Job name shown in the page header.
  --src-root <dir>  Top-level directory of your own code, used to pick the
                    meaningful stack frame when grouping failures. Default: src

Other
  --help            This text.

Exit codes
  0  Report rendered. Also returned when --junit is missing from disk: a test
     run that died before writing results should not fail the reporting step,
     and existing history is left untouched.
  1  Usage error, or the store does not exist and --init was not passed.

About --init
  Leaving --init in place permanently is the one configuration mistake that
  silently destroys history. If the job later runs somewhere the store volume
  is not mounted, --init cheerfully creates an empty directory and you start
  again from one build. Without it, that situation fails loudly instead.
`;

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (!args.store || args.store === true) {
    console.error(`${PREFIX} missing --store`);
    return 1;
  }
  if (!args.out || args.out === true) {
    console.error(`${PREFIX} missing --out`);
    return 1;
  }

  const storeDir = String(args.store);

  if (!store.storeExists(storeDir)) {
    if (!args.init) {
      console.error(
        `${PREFIX} store not found: ${storeDir}\n` +
          `${PREFIX} Pass --init on the first run to create it. Remove --init afterwards,\n` +
          `${PREFIX} so a missing store fails loudly instead of silently starting over.`,
      );
      return 1;
    }
    store.initStore(storeDir);
    console.log(`${PREFIX} created store ${storeDir}`);
  }

  // ---- record this build ------------------------------------------------
  if (args.junit && !args.build) {
    console.error(`${PREFIX} --junit needs --build <number>`);
    return 1;
  }
  if (args.junit && args.build) {
    const build = parseBuildNumber(args.build);
    if (build === null) {
      console.error(`${PREFIX} --build must be a non-negative integer, got: ${args.build}`);
      return 1;
    }
    const junitPath = String(args.junit);

    if (!fs.existsSync(junitPath)) {
      console.warn(`${PREFIX} ${junitPath} not found - keeping existing history untouched`);
    } else {
      const srcRoot = args["src-root"] ? String(args["src-root"]) : "src";
      const { tests, totals } = parseJUnitFile(junitPath, (body) => signatureOf(body, srcRoot));

      const record = {
        build,
        branch: args.branch === true ? "" : String(args.branch || ""),
        env: envOf(args.env === true ? "" : args.env),
        url: args.url === true ? "" : String(args.url || ""),
        date: new Date().toISOString(),
        totals,
        tests,
      };

      const dest = store.writeBuild(storeDir, record);
      console.log(
        `${PREFIX} wrote ${dest} - ${totals.tests} tests, ${totals.failures} failed, ${totals.skipped} skipped`,
      );
    }
  }

  // ---- render -----------------------------------------------------------
  const builds = store.readStore(storeDir);
  if (!builds.length) {
    console.warn(`${PREFIX} no builds in ${storeDir} - nothing to render`);
    return 0;
  }

  const data = store.buildMatrix(builds, clusterFailures);
  data.job = args.job === true ? "" : String(args.job || path.basename(storeDir));
  data.generated = new Date().toISOString();

  const html = renderHtml(fs.readFileSync(TEMPLATE, "utf8"), data);

  fs.mkdirSync(path.dirname(path.resolve(String(args.out))), { recursive: true });
  fs.writeFileSync(String(args.out), html);

  console.log(
    `${PREFIX} rendered ${args.out} - ${data.builds.length} builds, ` +
      `${data.tests.length} tests, ${data.clusters.length} causes`,
  );
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { parseArgs, parseBuildNumber, escapeHtml, serialiseForScript, renderHtml, main };
