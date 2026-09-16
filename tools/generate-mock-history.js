#!/usr/bin/env node
"use strict";

/**
 * Mock history generator.
 *
 * Produces a believable build history for a fictional e-commerce Playwright
 * suite ("Acme Shop"), so the tool can be tried, screenshotted and demoed
 * without a Jenkins instance or a real test suite.
 *
 * It does NOT fabricate store files directly. It writes real JUnit XML and
 * feeds it through the same parser and store writer the production path uses,
 * so the demo report is genuinely produced by the tool rather than mocked
 * alongside it. If the parser breaks, the demo breaks.
 *
 *   node tools/generate-mock-history.js --out .mock-store --builds 14
 *
 * Output is deterministic: the same arguments always produce the same history,
 * so a committed demo report does not churn on every regeneration.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { parseJUnitFile } = require("../src/lib/junit");
const { signatureOf } = require("../src/lib/signature");
const { envOf } = require("../src/lib/env");
const store = require("../src/lib/store");

/* ------------------------------------------------------------------ *
 * Deterministic PRNG - mulberry32. Seeded so demo output is stable.
 * ------------------------------------------------------------------ */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * The fictional suite
 * ------------------------------------------------------------------ */

/** @type {Array<{id: string, title: string, spec: string, from?: number, until?: number}>} */
const CATALOGUE = [
  // auth
  { id: "TC-1001", title: "Sign in with a valid account", spec: "auth" },
  { id: "TC-1002", title: "Reject sign in with a wrong password", spec: "auth" },
  { id: "TC-1003", title: "Lock the account after five failed attempts", spec: "auth" },
  { id: "TC-1004", title: "Send a password reset email", spec: "auth" },
  { id: "TC_GuestCheckoutAllowed", title: "Allow checkout without an account", spec: "auth" },
  // search
  { id: "TC-1010", title: "Search returns matching products", spec: "search" },
  { id: "TC-1011", title: "Search handles an empty result set", spec: "search" },
  { id: "TC-1012", title: "Search suggestions appear while typing", spec: "search" },
  { id: "TC-1013", title: "Filter results by price range", spec: "search" },
  { id: "TC-1014", title: "Filter results by brand", spec: "search" },
  { id: "TC-1015", title: "Sort results by price ascending", spec: "search" },
  { id: "TC-1016", title: "Paginate through long result lists", spec: "search" },
  // product
  { id: "TC-1020", title: "Product page shows price and stock", spec: "product" },
  { id: "TC-1021", title: "Switch between product image variants", spec: "product" },
  { id: "TC-1022", title: "Select a size before adding to cart", spec: "product" },
  { id: "TC-1023", title: "Out of stock hides the add-to-cart button", spec: "product" },
  { id: "TC-1024", title: "Related products render below the fold", spec: "product" },
  { id: "TC-1025", title: "Customer reviews load on demand", spec: "product", from: 6 },
  { id: "TC-1026", title: "Review rating filter narrows the list", spec: "product", from: 6 },
  // cart
  { id: "TC-1030", title: "Add a single item to the cart", spec: "cart" },
  { id: "TC-1031", title: "Increase the quantity of a cart line", spec: "cart" },
  { id: "TC-1032", title: "Remove a line from the cart", spec: "cart" },
  { id: "TC-1033", title: "Cart badge reflects the item count", spec: "cart" },
  { id: "TC-1034", title: "Cart survives a page reload", spec: "cart" },
  { id: "TC-1035", title: "Apply a percentage discount code", spec: "cart" },
  { id: "TC-1036", title: "Reject an expired discount code", spec: "cart" },
  { id: "TC-1037", title: "Legacy cart merge on sign in", spec: "cart", until: 10 },
  // checkout
  { id: "TC-1040", title: "Complete checkout with a saved card", spec: "checkout" },
  { id: "TC-1041", title: "Complete checkout as a guest", spec: "checkout" },
  { id: "TC-1042", title: "Validate required address fields", spec: "checkout" },
  { id: "TC-1043", title: "Switch delivery method updates the total", spec: "checkout" },
  { id: "TC-1044", title: "Apply store credit at checkout", spec: "checkout" },
  { id: "TC-1045", title: "Decline an invalid card number", spec: "checkout" },
  { id: "TC-1046", title: "Order confirmation shows the order number", spec: "checkout" },
  { id: "TC_CheckoutAddressBook", title: "Pick an address from the address book", spec: "checkout" },
  // account
  { id: "TC-1050", title: "Update the account display name", spec: "account" },
  { id: "TC-1051", title: "Add a new delivery address", spec: "account" },
  { id: "TC-1052", title: "Order history lists past orders", spec: "account" },
  { id: "TC-1053", title: "Download an invoice as PDF", spec: "account" },
  { id: "TC-1054", title: "Manage marketing preferences", spec: "account" },
  // payments
  { id: "TC-1060", title: "Register a new payment card", spec: "payments" },
  { id: "TC-1061", title: "Delete a stored payment card", spec: "payments" },
  { id: "TC-1062", title: "Refund shows on the order", spec: "payments", from: 6 },
];

/**
 * The defects driving the history. `builds` is an inclusive 1-based range over
 * the generated builds, so the narrative reads the same at any --builds count.
 */
const DEFECTS = [
  {
    name: "checkout-timeout",
    error: "locator.click: Timeout 30000ms exceeded.\n  waiting for getByRole('button', { name: 'Place order' })",
    frame: "src/pages/checkout.page.ts:118",
    tests: ["TC-1040", "TC-1041", "TC-1043", "TC-1044", "TC-1046", "TC_CheckoutAddressBook"],
    builds: [1, 8],
  },
  {
    name: "cart-total-drift",
    error: "expect(received).toEqual(expected)\n  Expected: \"£42.00\"\n  Received: \"£41.90\"",
    frame: "src/pages/cart.page.ts:64",
    tests: ["TC-1035", "TC-1036", "TC-1031"],
    builds: [3, 99],
  },
  {
    name: "auth-navigation",
    error: "page.waitForURL: Timeout 15000ms exceeded.\n  waiting for navigation to \"**/account\"",
    frame: "src/pages/auth.page.ts:41",
    tests: ["TC-1001", "TC-1003", "TC-1004", "TC_GuestCheckoutAllowed"],
    builds: [1, 4],
  },
  {
    name: "reviews-regression",
    error: "locator.waitFor: Timeout 20000ms exceeded.\n  waiting for locator('[data-test=review-list]') to be visible",
    frame: "src/pages/product.page.ts:203",
    tests: ["TC-1025", "TC-1026", "TC-1024"],
    builds: [12, 99],
  },
  {
    name: "invoice-download",
    error: "Error: Download did not start within 10000ms",
    frame: "src/pages/account.page.ts:157",
    tests: ["TC-1053"],
    builds: [1, 99],
  },
];

/** Tests that flip on their own, independent of any defect. */
const FLAKY = {
  tests: ["TC-1012", "TC-1016", "TC-1034"],
  error: "locator.click: Timeout 30000ms exceeded.\n  element is not stable - waiting for it to stop moving",
  frame: "src/pages/search.page.ts:88",
  chance: 0.34,
};

/** Tests skipped in particular builds, to exercise the skipped path. */
const SKIPS = { tests: ["TC-1060", "TC-1061"], builds: [5, 6, 7] };

const ENV_PLAN = ["staging", "staging", "staging", "staging", "staging", "dev", "staging",
                  "staging", "staging", "staging", "prod", "staging", "staging", "staging"];

const BRANCH_PLAN = { 6: "feature/product-reviews", 11: "release/2.4", 12: "feature/product-reviews" };

/* ------------------------------------------------------------------ */

function inRange(n, range) {
  return n >= range[0] && n <= range[1];
}

/**
 * Decide the outcome of one test in one build.
 *
 * @returns {{status: "P"|"F"|"S", defect: object|null}}
 */
function outcomeFor(test, buildIdx, rand) {
  if (SKIPS.tests.includes(test.id) && SKIPS.builds.includes(buildIdx)) {
    return { status: "S", defect: null };
  }

  for (const d of DEFECTS) {
    if (!d.tests.includes(test.id)) continue;
    if (!inRange(buildIdx, d.builds)) continue;
    return { status: "F", defect: d };
  }

  if (FLAKY.tests.includes(test.id) && rand() < FLAKY.chance) {
    return { status: "F", defect: FLAKY };
  }

  return { status: "P", defect: null };
}

/** Escape text for an XML attribute. */
function xmlAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Render one build as a Playwright-shaped JUnit XML document, including the
 * `<system-out>` logging that makes signature extraction non-trivial in real
 * life - it is here on purpose, so the demo proves the parser ignores it.
 */
function renderJUnit(rows, buildIdx) {
  const failures = rows.filter((r) => r.status === "F").length;
  const skipped = rows.filter((r) => r.status === "S").length;

  const cases = rows.map(({ test, status, defect }) => {
    const suiteName = "@e2e › " + test.spec;
    const name = `${suiteName} › ${test.id} @e2e '${test.title}'`;
    const attrs = `name="${xmlAttr(name)}" classname="src/tests/${test.spec}.spec.ts" time="${(2 + (buildIdx % 5)).toFixed(3)}"`;

    const log =
      `<system-out><![CDATA[2026-03-${String(buildIdx + 9).padStart(2, "0")} 09:${String(10 + buildIdx).padStart(2, "0")}:04 [INFO] : starting ${test.id}\n` +
      `2026-03-${String(buildIdx + 9).padStart(2, "0")} 09:${String(10 + buildIdx).padStart(2, "0")}:07 [INFO] : navigating to /${test.spec}\n]]></system-out>`;

    if (status === "S") return `    <testcase ${attrs}><skipped/>${log}</testcase>`;
    if (status === "P") return `    <testcase ${attrs}>${log}</testcase>`;

    const body =
      `    ${defect.error}\n\n` +
      `        at ${defect.frame}\n` +
      `        at src/tests/${test.spec}.spec.ts:${40 + (buildIdx % 30)}\n` +
      `        at node_modules/@playwright/test/lib/worker.js:210\n`;

    return (
      `    <testcase ${attrs}>\n` +
      `      <failure message="${xmlAttr(defect.error.split("\n")[0])}" type="FAILURE"><![CDATA[\n${body}]]></failure>\n` +
      `      ${log}\n` +
      `    </testcase>`
    );
  });

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites id="" name="" tests="${rows.length}" failures="${failures}" skipped="${skipped}" errors="0" time="${rows.length * 3}">\n` +
    `  <testsuite name="acme-shop" tests="${rows.length}" failures="${failures}" skipped="${skipped}" errors="0" time="${rows.length * 3}">\n` +
    cases.join("\n") +
    `\n  </testsuite>\n</testsuites>\n`
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = String(args.out || ".mock-store");
  const count = Number(args.builds || 14);
  const firstBuild = Number(args["first-build"] || 101);

  fs.rmSync(outDir, { recursive: true, force: true });
  store.initStore(outDir);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mock-junit-"));
  const rand = rng(20260301);

  for (let i = 1; i <= count; i++) {
    const buildNumber = firstBuild + i - 1;

    const rows = CATALOGUE.filter((t) => i >= (t.from || 1) && i <= (t.until || 1e9)).map((test) => {
      const { status, defect } = outcomeFor(test, i, rand);
      return { test, status, defect };
    });

    const xmlPath = path.join(tmp, `results-${buildNumber}.xml`);
    fs.writeFileSync(xmlPath, renderJUnit(rows, i));

    // Straight through the production path - same parser, same store writer.
    const { tests, totals } = parseJUnitFile(xmlPath, (b) => signatureOf(b, "src"));

    const env = ENV_PLAN[(i - 1) % ENV_PLAN.length];
    const day = new Date(Date.UTC(2026, 2, 9 + i, 9, 15, 0));

    store.writeBuild(outDir, {
      build: buildNumber,
      branch: BRANCH_PLAN[i] || "main",
      env: envOf(`https://${env === "prod" ? "" : env + "."}acme-shop.test`),
      url: `https://ci.example.test/job/acme-shop-e2e/${buildNumber}/`,
      date: day.toISOString(),
      totals,
      tests,
    });

    console.log(
      `  build-${String(buildNumber).padStart(4, "0")}.json  ` +
        `${String(totals.tests).padStart(2)} tests  ${String(totals.failures).padStart(2)}F ` +
        `${totals.skipped}S  ${env}`,
    );
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nWrote ${count} builds to ${outDir}`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { CATALOGUE, DEFECTS, renderJUnit, outcomeFor };
