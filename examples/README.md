# Example Playwright suite

A minimal Playwright setup showing what playwright-test-history expects as
input. It isn't run by `npm test` and isn't a dependency of the tool. Copy the
parts you need into your own project.

| File | Shows |
|---|---|
| `playwright.config.ts` | JUnit reporter enabled next to the HTML report |
| `tests/checkout.spec.ts` | Test names that carry a stable `TC-<number>` id |

## Run it

```bash
cd examples
npm init -y && npm i -D @playwright/test
npx playwright install chromium
BASE_URL=https://your-app.example.com npx playwright test
```

Then record the run and render the report from the repo root:

```bash
node src/triage-report.js \
  --init \
  --junit examples/playwright-report/results.xml \
  --build 1 \
  --store .triage-store \
  --out triage-report/index.html
```

`--init` is only needed on the very first run. Increase `--build` each time.
