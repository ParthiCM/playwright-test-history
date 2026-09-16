#!/bin/bash
# ---------------------------------------------------------------------------
# Jenkins > Configure > Build > Execute shell
#
# Paste the block below into an existing Playwright job, immediately ABOVE the
# step's final `exit`. Change --job and --store for each job you add it to.
#
# GIVE EVERY JOB ITS OWN STORE DIRECTORY. Two jobs sharing one store will
# interleave their build numbers and produce a meaningless report.
# ---------------------------------------------------------------------------

# Your existing test run, roughly:
#
#   npx playwright test --project=chrome
#   EXIT_STATUS=$?
#
# ...then, before you exit:

# ---------------------------------------------------------------------------
# Cross-build test history report
#
# Written on ONE line on purpose. Backslash line-continuations are the single
# most common way this step breaks: a trailing space after a backslash stops it
# continuing, bash splits the command in two, and you get
#   "missing --store" followed by "--junit: command not found"
# while the build is marked failed even though the tests passed.
# ---------------------------------------------------------------------------
node src/e2e-tests/utils/triage/triage-report.js --junit playwright-report/results.xml --build "$BUILD_NUMBER" --branch "$BRANCH_NAME" --env "$BASE_URL" --url "$BUILD_URL" --job "acme-shop-e2e" --store /var/jenkins_home/ci-data/triage/acme-shop-e2e --out triage-report/index.html

exit $EXIT_STATUS


# ===========================================================================
# Optional extras
# ===========================================================================
#
# 1. FIRST RUN ONLY - add --init so the store directory is created:
#
#      node .../triage-report.js --init --junit ... --store ... --out ...
#
#    REMOVE IT AFTERWARDS. Left in place, a job that later runs on an agent
#    where the store volume is not mounted will silently create an empty
#    directory and start history again from one build. Without --init, that
#    situation fails loudly instead.
#
#
# 2. If your job has a "re-run only failed tests" parameter, skip the report on
#    those runs. They execute a subset, so recording one makes every other test
#    look like it vanished from the suite that build:
#
#      if [ "${RERUN_FAILED_ONLY}" = "true" ]; then
#          echo "Partial run - skipping the history report."
#      else
#          node .../triage-report.js --junit ... --store ... --out ...
#      fi
#
#
# 3. If your job does NOT use the Workspace Cleanup plugin, delete the output
#    directories before the run. Otherwise a run that dies before writing
#    results.xml leaves the previous build's files on disk, and the report
#    step happily records stale results as if they were this build's:
#
#      rm -rf ./playwright-report/* ./triage-report
#
#
# 4. Where does --env come from? Any variable holding the URL the suite ran
#    against. Common names: BASE_URL, TEST_ENV, APP_URL. The value is
#    normalised to dev / staging / prod, so a full URL is fine. Omitting --env
#    is safe - those builds simply render with a neutral dash.
