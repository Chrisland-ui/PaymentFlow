# Frontend API Contract Tests

**Issue #24** — Prevent frontend assumptions about API response shapes from drifting silently.

## Overview

Contract tests ensure that when the backend changes a response shape, CI catches it before the change reaches production. The mechanism is:

1. **Fixtures** (`tests/fixtures/contracts/api-contract-fixtures.json`) — canonical JSON snapshots of each endpoint's documented success and error responses, derived from the API specification.
2. **Parser helpers** in `tests/apiContractTests.test.js` — functions that mirror exactly what React components do with the response data (field access by name, array iteration, etc.).
3. **Assertions** — any `undefined` field access or wrong type fails the test.

## When tests fail

A failing contract test means one of:

- A backend field was **renamed** (e.g. `totalPaid` → `amountPaid`).
- A field's **type changed** (e.g. `status` became a number).
- A **required field was dropped** from a response.
- An **error envelope** no longer includes `error` (string) and `code` (string).

Check the failing assertion, find the backend change that caused it, and update either the backend to preserve backward compatibility or — after coordinating with all consumers — update the fixture and the frontend component together.

## Adding a new endpoint

### Step 1: Add the fixture

Edit `tests/fixtures/contracts/api-contract-fixtures.json` and add a new key under `responses`:

```json
"GET /my-new-endpoint": {
  "success": {
    "field1": "value",
    "field2": 123
  },
  "errors": {
    "NOT_FOUND": {
      "status": 404,
      "body": { "error": "Resource not found", "code": "NOT_FOUND" }
    }
  }
}
```

Rules for fixtures:
- Use realistic but **non-sensitive** placeholder values.
- Never include real wallet addresses, real student names, PII, or credentials.
- Cover at least one success shape and every documented error code.

### Step 2: Add parser helpers

In `tests/apiContractTests.test.js`, add a helper that mirrors how the React component accesses the data:

```js
function parseMyNewEndpoint(response) {
  return {
    field1: response.field1,
    field2: response.field2,
  };
}
```

### Step 3: Add assertions

```js
describe('GET /my-new-endpoint', () => {
  const fixture = fixtures.responses['GET /my-new-endpoint'];

  test('success: required fields are present', () => {
    const p = parseMyNewEndpoint(fixture.success);
    expect(typeof p.field1).toBe('string');
    expect(typeof p.field2).toBe('number');
  });

  test('error NOT_FOUND: code and status 404', () => {
    const err = parseError(fixture.errors.NOT_FOUND.body);
    expect(err.code).toBe('NOT_FOUND');
    expect(fixture.errors.NOT_FOUND.status).toBe(404);
  });
});
```

### Step 4: Run locally

```bash
npm test tests/apiContractTests.test.js
```

## CI integration

The contract tests run as part of the standard `npm test` suite in the `test` CI job. Any failure blocks the `ci-gate` job and prevents merging.

## Error envelope guarantee

Every API error response **must** follow this shape:

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

The frontend `errorMessages.js` module routes user-facing messages by `code`. A response missing `code` will silently show a generic fallback instead of the translated message.

The universal envelope assertions in `apiContractTests.test.js` enforce this for every documented error across all endpoints.
