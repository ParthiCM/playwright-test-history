"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { envOf, capOf, isKnown } = require("../src/lib/env");

test("envOf reads the environment from a subdomain", () => {
  assert.equal(envOf("https://staging.acme-shop.test/"), "staging");
  assert.equal(envOf("https://dev.acme-shop.test"), "dev");
  assert.equal(envOf("http://qa.acme-shop.test/path?x=1"), "staging");
});

test("envOf treats an apex domain as production", () => {
  // No subdomain means the live site. This is the case people forget, and
  // getting it wrong labels every production run as unknown.
  assert.equal(envOf("https://acme-shop.test"), "prod");
  assert.equal(envOf("https://www.acme-shop.test"), "prod");
});

test("envOf maps common aliases onto the three coloured environments", () => {
  assert.equal(envOf("https://preprod.acme-shop.test"), "staging");
  assert.equal(envOf("https://uat.acme-shop.test"), "staging");
  assert.equal(envOf("https://features.acme-shop.test"), "dev");
  assert.equal(envOf("https://live.acme-shop.test"), "prod");
});

test("envOf accepts a bare environment name, not only a URL", () => {
  assert.equal(envOf("staging"), "staging");
  assert.equal(envOf("preprod"), "staging");
  assert.equal(envOf("PROD"), "prod");
});

test("envOf records an unrecognised environment rather than discarding it", () => {
  assert.equal(envOf("https://sandbox.acme-shop.test"), "sandbox");
  assert.equal(isKnown("sandbox"), false, "it just renders in the neutral colour");
});

test("envOf ignores scheme, port, credentials, path and case", () => {
  assert.equal(envOf("HTTPS://Staging.Acme-Shop.test:8443/checkout#top"), "staging");
  assert.equal(envOf("https://user:pass@staging.acme-shop.test"), "staging");
});

test("envOf returns empty for nothing at all", () => {
  assert.equal(envOf(""), "");
  assert.equal(envOf(null), "");
  assert.equal(envOf(undefined), "");
  assert.equal(envOf("   "), "");
});

test("capOf produces a label that fits a build column", () => {
  assert.equal(capOf("dev"), "DEV");
  assert.equal(capOf("staging"), "STG");
  assert.equal(capOf("prod"), "PROD");
  assert.equal(capOf("sandbox"), "SAND", "unknown names are capped to four characters");
  assert.equal(capOf(""), "—");
  assert.ok(capOf("averylongenvironmentname").length <= 4);
});
