# Cross-Browser Smoke Matrix

`tests/smoke/cross-browser-smoke.test.js` validates that the four core payment
workflows (login, payment creation, payment status refresh, report download)
behave correctly across all supported browser engines.

## Browser matrix

| ID | Engine | Type | Viewport |
|----|--------|------|----------|
| `chromium` | Chromium | Desktop | 1280×720 |
| `firefox` | Firefox | Desktop | 1280×720 |
| `webkit` | WebKit/Safari | Desktop | 1280×720 |
| `mobile_chrome` | Chromium | Mobile | 390×844 |
| `mobile_safari` | WebKit | Mobile | 390×844 |

Defined in `tests/smoke/browserMatrix.js`.

## Running the tests

```bash
# From project root
npx jest tests/smoke/ --forceExit
```

The suite runs in CI on every pull request via the `cross-browser-smoke` job
in `.github/workflows/ci.yml`.

## Environment-dependent tests

Tests tagged `@requires-live-server` are skipped unless `SMOKE_LIVE_URL` is
set. Set it to the root URL of a running application to exercise the real
network flows:

```bash
SMOKE_LIVE_URL=http://localhost:3000 npx jest tests/smoke/ --forceExit
```

These tests are isolated in their own `itLive` block inside each browser
describe so they cannot interfere with the mock-based matrix.

## Failure artifacts

On failure, the test writes a JSON screenshot stub to `test-results/smoke/`.
The CI `upload-artifact` step collects these for review. Stubs contain:

- browser ID, engine, type, and viewport
- the page path and timestamp
- the error message

Stubs deliberately omit credentials, tokens, and any PII.

## Playwright upgrade path

When a live server is available in CI (e.g., via Docker Compose service
containers), replace `createMockPage` with real Playwright calls:

```js
const { chromium, firefox, webkit } = require('@playwright/test');
// map browser.engine -> chromium | firefox | webkit
const browserInstance = await chromium.launch();
const context = await browserInstance.newContext({ viewport: browser.viewport, userAgent: browser.userAgent });
const page = await context.newPage();
```

Install Playwright with:

```bash
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium firefox webkit
```

Then update the `cross-browser-smoke` CI job to run
`npx playwright test tests/smoke/` instead of Jest.
