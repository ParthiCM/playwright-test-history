"use strict";

/**
 * Environment normalisation.
 *
 * A suite that runs against staging on Monday and production on Tuesday will
 * produce two builds whose failures are not comparable. Recording which
 * environment each build ran against turns that from a silent trap into
 * something the reader can see and filter on.
 *
 * The report colours the three environments below. Anything else still gets
 * recorded and labelled - it just renders in the neutral "other" colour rather
 * than being silently dropped.
 */

/** Environments the report has a dedicated colour for. */
const KNOWN = ["dev", "staging", "prod"];

/**
 * Host labels that mean the same thing as one of the KNOWN names. Extend this
 * to match your own naming - the report picks up whatever you map to.
 */
const ALIASES = {
  local: "dev",
  localhost: "dev",
  develop: "dev",
  development: "dev",
  feature: "dev",
  features: "dev",
  qa: "staging",
  test: "staging",
  stage: "staging",
  staging: "staging",
  preprod: "staging",
  "pre-prod": "staging",
  uat: "staging",
  prod: "prod",
  production: "prod",
  live: "prod",
  www: "prod",
};

/** Short caps shown on the chip. Four characters is the most a build column fits. */
const CAPS = { dev: "DEV", staging: "STG", prod: "PROD" };

/**
 * Normalise a URL, hostname or bare label into an environment name.
 *
 * Accepts what a CI job actually has to hand - usually the base URL the suite
 * was pointed at, which is why a URL is the primary input.
 *
 *   https://staging.acme-shop.test/  -> "staging"
 *   https://acme-shop.test           -> "prod"   (no subdomain means the root site)
 *   preprod                          -> "staging" (via alias)
 *   https://sandbox.acme-shop.test   -> "sandbox" (recorded, rendered neutral)
 *   ""                               -> ""        (not recorded)
 *
 * @param {string} value URL, hostname, or an environment name.
 * @returns {string} Normalised environment, or "" when nothing was supplied.
 */
function envOf(value) {
  const raw = String(value == null ? "" : value).trim();
  if (!raw) return "";

  const host = raw
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0]
    .split("@")
    .pop()
    .split(":")[0]
    .toLowerCase();

  if (!host) return "";

  const labels = host.split(".").filter(Boolean);
  if (!labels.length) return "";

  const first = labels[0];
  if (ALIASES[first]) return ALIASES[first];

  // A bare word that was never a hostname, e.g. --env staging
  if (labels.length === 1) return ALIASES[first] || first;

  // apex domain with no subdomain - that is the live site
  if (labels.length === 2) return "prod";

  return first;
}

/**
 * Short uppercase label for the chip. Unknown environments are capped to four
 * characters so they still fit a build column.
 *
 * @param {string} env
 * @returns {string}
 */
function capOf(env) {
  if (!env) return "—";
  return CAPS[env] || env.slice(0, 4).toUpperCase();
}

/**
 * Whether the report has a dedicated colour for this environment.
 *
 * @param {string} env
 * @returns {boolean}
 */
function isKnown(env) {
  return KNOWN.indexOf(env) >= 0;
}

module.exports = { KNOWN, ALIASES, CAPS, envOf, capOf, isKnown };
