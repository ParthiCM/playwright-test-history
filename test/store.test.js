"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../src/lib/store");
const { clusterFailures } = require("../src/lib/signature");

/** @returns {string} a fresh empty store directory */
function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-test-"));
  store.initStore(dir);
  return dir;
}

const rec = (n, tests, extra) =>
  Object.assign(
    {
      build: n,
      branch: "main",
      env: "staging",
      totals: {
        tests: tests.length,
        failures: tests.filter((t) => t.status === "F").length,
        skipped: tests.filter((t) => t.status === "S").length,
        passed: tests.filter((t) => t.status === "P").length,
      },
      tests,
    },
    extra || {},
  );

test("fileNameFor zero-pads so a directory listing sorts correctly", () => {
  assert.equal(store.fileNameFor(7), "build-0007.json");
  assert.equal(store.fileNameFor(1234), "build-1234.json");
  // Beyond the pad width it still works, it just stops aligning.
  assert.equal(store.fileNameFor(99999), "build-99999.json");
});

test("readStore returns builds oldest-first regardless of write order", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(12, []));
  store.writeBuild(dir, rec(3, []));
  store.writeBuild(dir, rec(7, []));

  assert.deepEqual(store.readStore(dir).map((b) => b.build), [3, 7, 12]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("re-running a build replaces only that build", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(1, [{ id: "TC-1", status: "F", sig: "x" }]));
  store.writeBuild(dir, rec(2, [{ id: "TC-1", status: "F", sig: "x" }]));
  store.writeBuild(dir, rec(2, [{ id: "TC-1", status: "P", sig: "" }]));

  const builds = store.readStore(dir);
  assert.equal(builds.length, 2, "no duplicate column");
  assert.equal(builds[0].tests[0].status, "F", "the untouched build is untouched");
  assert.equal(builds[1].tests[0].status, "P", "the re-run build is replaced");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("one corrupt file does not take the whole report down", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(1, []));
  fs.writeFileSync(path.join(dir, "build-0002.json"), "{ not json");
  store.writeBuild(dir, rec(3, []));

  assert.deepEqual(store.readStore(dir).map((b) => b.build), [1, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readStore on a missing directory is empty, not an exception", () => {
  assert.deepEqual(store.readStore(path.join(os.tmpdir(), "definitely-not-here-" + Date.now())), []);
});

test("countFlips ignores skips and absences", () => {
  assert.equal(store.countFlips(["P", "P", "P"]), 0);
  assert.equal(store.countFlips(["P", "F", "P"]), 2);
  assert.equal(store.countFlips(["F", "F", "F"]), 0);
  assert.equal(store.countFlips(["P", "-", "F"]), 1);
  assert.equal(store.countFlips(["P", "S", "P"]), 0, "a skip is not a flip");
  assert.equal(store.countFlips([]), 0);
});

test("failingSince finds the start of the current failing run only", () => {
  assert.equal(store.failingSince(["P", "F", "F"], [1, 2, 3]), 2);
  assert.equal(store.failingSince(["F", "P", "F"], [1, 2, 3]), 3, "an earlier run does not count");
  assert.equal(store.failingSince(["F", "F", "F"], [1, 2, 3]), 1);
  assert.equal(store.failingSince(["F", "F", "P"], [1, 2, 3]), null, "green now means no run");
  assert.equal(store.failingSince(["P", "F", "S"], [1, 2, 3]), 2, "a trailing skip is looked through");
  assert.equal(store.failingSince(["-", "-", "-"], [1, 2, 3]), null);
});

test("buildMatrix marks builds a test was absent from, rather than assuming a pass", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(1, [{ id: "TC-1", title: "one", suite: "a", status: "P" }]));
  store.writeBuild(dir, rec(2, [
    { id: "TC-1", title: "one", suite: "a", status: "P" },
    { id: "TC-2", title: "two", suite: "a", status: "F", sig: "boom  @  src/a.ts:1" },
  ]));

  const m = store.buildMatrix(store.readStore(dir), clusterFailures);
  const added = m.tests.find((t) => t.id === "TC-2");

  assert.deepEqual(added.s, ["-", "F"], "absent in build 1, not silently green");
  assert.equal(added.runs, 1, "an absence is not an executed run");
  assert.equal(added.since, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildMatrix puts currently-failing tests at the top", () => {
  const dir = tmpStore();
  const tests = [
    { id: "TC-green", title: "g", suite: "a", status: "P" },
    { id: "TC-red", title: "r", suite: "a", status: "F", sig: "boom  @  src/a.ts:1" },
  ];
  store.writeBuild(dir, rec(1, tests));
  store.writeBuild(dir, rec(2, tests));

  const m = store.buildMatrix(store.readStore(dir), clusterFailures);
  assert.equal(m.tests[0].id, "TC-red", "the reader should not have to filter to see the problem");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildMatrix takes a renamed test's newest title", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(1, [{ id: "TC-1", title: "old name", suite: "a", status: "P" }]));
  store.writeBuild(dir, rec(2, [{ id: "TC-1", title: "new name", suite: "a", status: "P" }]));

  const m = store.buildMatrix(store.readStore(dir), clusterFailures);
  assert.equal(m.tests[0].title, "new name");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildMatrix clusters only the latest build's failures", () => {
  const dir = tmpStore();
  store.writeBuild(dir, rec(1, [{ id: "TC-1", title: "a", suite: "a", status: "F", sig: "old  @  src/a.ts:1" }]));
  store.writeBuild(dir, rec(2, [{ id: "TC-1", title: "a", suite: "a", status: "P" }]));

  const m = store.buildMatrix(store.readStore(dir), clusterFailures);
  assert.deepEqual(m.clusters, [], "a failure that is already fixed is not a current cause");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("storeExists distinguishes missing from present", () => {
  const dir = tmpStore();
  assert.equal(store.storeExists(dir), true);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(store.storeExists(dir), false);
});
