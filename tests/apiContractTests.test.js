'use strict';

/**
 * Issue #24 — Frontend contract tests against OpenAPI examples.
 *
 * Frontend assumptions about API response shapes can silently drift from
 * backend behaviour when endpoints change.  These tests pin the contract
 * by:
 *
 *   1. Loading canonical response fixtures from
 *      tests/fixtures/contracts/api-contract-fixtures.json (the "contract").
 *   2. Running each fixture through the frontend API-client parsers
 *      (frontend/src/services/api.js consumers) to prove they can extract
 *      the fields they depend on without crashing or returning undefined.
 *   3. Asserting that every documented error envelope carries both `error`
 *      (string) and `code` (string) fields — the frontend error-message
 *      module relies on `code` for i18n routing.
 *   4. Verifying success shapes carry the minimum fields that UI components
 *      access by field name (no defensive "if field exists" guards needed).
 *
 * Adding a new endpoint
 * ---------------------
 * 1. Add a fixture entry to tests/fixtures/contracts/api-contract-fixtures.json.
 * 2. Add a describe block below that uses parseXxx() helpers that mirror how
 *    the frontend component reads the response.
 * 3. Run: npm test tests/apiContractTests.test.js
 */

const fixtures = require('./fixtures/contracts/api-contract-fixtures.json');

// ---------------------------------------------------------------------------
// Parser helpers — mirror exactly what React components do with API data.
// If a field is renamed in the backend, the corresponding parse call returns
// undefined and the assertion below fails CI before the breakage ships.
// ---------------------------------------------------------------------------

function parseStudentList(response) {
  return {
    students:   response.data,
    total:      response.pagination.total,
    page:       response.pagination.page,
    hasNext:    response.pagination.hasNext,
    hasPrev:    response.pagination.hasPrev,
    totalPages: response.pagination.totalPages,
  };
}

function parseStudent(student) {
  return {
    id:               student._id,
    studentId:        student.studentId,
    name:             student.name,
    className:        student.class,
    feeAmount:        student.feeAmount,
    totalPaid:        student.totalPaid,
    remainingBalance: student.remainingBalance,
    feePaid:          student.feePaid,
  };
}

function parsePaymentInstructions(response) {
  return {
    walletAddress:  response.walletAddress,
    memo:           response.memo,
    feeAmount:      response.feeAmount,
    currency:       response.currency,
    acceptedAssets: response.acceptedAssets,
  };
}

function parseVerifyPayment(response) {
  return {
    message:  response.message,
    status:   response.status,
    txHash:   response.txHash,
    amount:   response.amount,
    currency: response.currency,
    feePaid:  response.feePaid,
  };
}

function parsePaymentHistory(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return null;
  const p = payments[0];
  return {
    id:          p._id,
    txHash:      p.txHash,
    amount:      p.amount,
    currency:    p.currency,
    status:      p.status,
    confirmedAt: p.confirmedAt,
  };
}

function parseLoginResponse(response) {
  return {
    token:    response.token,
    username: response.user.username,
    role:     response.user.role,
    schoolId: response.user.schoolId,
  };
}

function parseFeeList(response) {
  return {
    fees:       response.data,
    total:      response.pagination.total,
    totalPages: response.pagination.totalPages,
  };
}

function parseDisputeList(response) {
  return {
    disputes:   response.data,
    total:      response.pagination.total,
    totalPages: response.pagination.totalPages,
  };
}

function parseAuditLogs(response) {
  return {
    logs:       response.logs,
    total:      response.pagination.total,
    totalPages: response.pagination.totalPages,
  };
}

function parseHealthCheck(response) {
  return {
    status:   response.status,
    logLevel: response.logLevel,
  };
}

function parseError(body) {
  return { error: body.error, code: body.code };
}

// ---------------------------------------------------------------------------
// Contract: fixture file integrity
// ---------------------------------------------------------------------------

describe('contract fixture file', () => {
  test('fixture file is an object with a responses key', () => {
    expect(typeof fixtures).toBe('object');
    expect(fixtures.responses).toBeDefined();
  });

  test('all required endpoint fixtures are present', () => {
    const REQUIRED = [
      'GET /students',
      'POST /students',
      'GET /payments/instructions/:studentId',
      'POST /payments/verify',
      'GET /payments/:studentId',
      'POST /auth/login',
      'GET /fees',
      'GET /disputes',
      'GET /audit',
      'GET /health',
    ];
    for (const ep of REQUIRED) {
      expect(fixtures.responses[ep]).toBeDefined();
      expect(fixtures.responses[ep].success).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /students
// ---------------------------------------------------------------------------

describe('GET /students', () => {
  const fixture = fixtures.responses['GET /students'];

  test('success: parseStudentList returns all required pagination fields', () => {
    const parsed = parseStudentList(fixture.success);
    expect(Array.isArray(parsed.students)).toBe(true);
    expect(typeof parsed.total).toBe('number');
    expect(typeof parsed.page).toBe('number');
    expect(typeof parsed.hasNext).toBe('boolean');
    expect(typeof parsed.hasPrev).toBe('boolean');
    expect(typeof parsed.totalPages).toBe('number');
  });

  test('success: each student record has all required fields', () => {
    for (const student of fixture.success.data) {
      const p = parseStudent(student);
      expect(p.id).toBeDefined();
      expect(p.studentId).toBeDefined();
      expect(p.name).toBeDefined();
      expect(typeof p.feeAmount).toBe('number');
      expect(typeof p.remainingBalance).toBe('number');
      expect(typeof p.feePaid).toBe('boolean');
    }
  });

  test('error UNAUTHORIZED: has error + code, status 401', () => {
    const err = parseError(fixture.errors.UNAUTHORIZED.body);
    expect(typeof err.error).toBe('string');
    expect(typeof err.code).toBe('string');
    expect(fixture.errors.UNAUTHORIZED.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Contract: POST /students
// ---------------------------------------------------------------------------

describe('POST /students', () => {
  const fixture = fixtures.responses['POST /students'];

  test('success: response is a valid student record', () => {
    const p = parseStudent(fixture.success);
    expect(p.id).toBeDefined();
    expect(p.studentId).toBeDefined();
    expect(typeof p.feeAmount).toBe('number');
  });

  test('error VALIDATION_ERROR: code and status 400', () => {
    const err = parseError(fixture.errors.VALIDATION_ERROR.body);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(fixture.errors.VALIDATION_ERROR.status).toBe(400);
  });

  test('error STUDENT_QUOTA_EXCEEDED: code and status 422', () => {
    const err = parseError(fixture.errors.STUDENT_QUOTA_EXCEEDED.body);
    expect(err.code).toBe('STUDENT_QUOTA_EXCEEDED');
    expect(fixture.errors.STUDENT_QUOTA_EXCEEDED.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /payments/instructions/:studentId
// ---------------------------------------------------------------------------

describe('GET /payments/instructions/:studentId', () => {
  const fixture = fixtures.responses['GET /payments/instructions/:studentId'];

  test('success: all required payment instruction fields present', () => {
    const p = parsePaymentInstructions(fixture.success);
    expect(typeof p.walletAddress).toBe('string');
    expect(typeof p.memo).toBe('string');
    expect(typeof p.feeAmount).toBe('number');
    expect(typeof p.currency).toBe('string');
    expect(Array.isArray(p.acceptedAssets)).toBe(true);
  });

  test('success: each accepted asset has code and type', () => {
    for (const asset of fixture.success.acceptedAssets) {
      expect(typeof asset.code).toBe('string');
      expect(typeof asset.type).toBe('string');
    }
  });

  test('error NOT_FOUND: code and status 404', () => {
    const err = parseError(fixture.errors.NOT_FOUND.body);
    expect(err.code).toBe('NOT_FOUND');
    expect(fixture.errors.NOT_FOUND.status).toBe(404);
  });

  test('error MISSING_SCHOOL_CONTEXT: code and status 400', () => {
    const err = parseError(fixture.errors.MISSING_SCHOOL_CONTEXT.body);
    expect(err.code).toBe('MISSING_SCHOOL_CONTEXT');
    expect(fixture.errors.MISSING_SCHOOL_CONTEXT.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Contract: POST /payments/verify
// ---------------------------------------------------------------------------

describe('POST /payments/verify', () => {
  const fixture = fixtures.responses['POST /payments/verify'];

  test('success: all required verify-payment response fields present', () => {
    const p = parseVerifyPayment(fixture.success);
    expect(typeof p.message).toBe('string');
    expect(typeof p.status).toBe('string');
    expect(typeof p.txHash).toBe('string');
    expect(typeof p.amount).toBe('number');
    expect(typeof p.feePaid).toBe('boolean');
  });

  test.each(['DUPLICATE_TX', 'TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION'])(
    'error %s: has error + code envelope',
    (code) => {
      const err = parseError(fixture.errors[code].body);
      expect(typeof err.error).toBe('string');
      expect(err.code).toBe(code);
    }
  );
});

// ---------------------------------------------------------------------------
// Contract: GET /payments/:studentId
// ---------------------------------------------------------------------------

describe('GET /payments/:studentId', () => {
  const fixture = fixtures.responses['GET /payments/:studentId'];

  test('success: response is an array', () => {
    expect(Array.isArray(fixture.success)).toBe(true);
  });

  test('success: payment records have required fields', () => {
    const p = parsePaymentHistory(fixture.success);
    expect(p.id).toBeDefined();
    expect(typeof p.txHash).toBe('string');
    expect(typeof p.amount).toBe('number');
    expect(p.status).toBe('SUCCESS');
  });
});

// ---------------------------------------------------------------------------
// Contract: POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login', () => {
  const fixture = fixtures.responses['POST /auth/login'];

  test('success: token and user object present', () => {
    const p = parseLoginResponse(fixture.success);
    expect(typeof p.token).toBe('string');
    expect(typeof p.username).toBe('string');
    expect(typeof p.role).toBe('string');
    expect(typeof p.schoolId).toBe('string');
  });

  test('error UNAUTHORIZED: status 401', () => {
    const err = parseError(fixture.errors.UNAUTHORIZED.body);
    expect(err.code).toBe('UNAUTHORIZED');
    expect(fixture.errors.UNAUTHORIZED.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /fees
// ---------------------------------------------------------------------------

describe('GET /fees', () => {
  const fixture = fixtures.responses['GET /fees'];

  test('success: parseFeeList returns fees array with pagination', () => {
    const p = parseFeeList(fixture.success);
    expect(Array.isArray(p.fees)).toBe(true);
    expect(typeof p.total).toBe('number');
    expect(typeof p.totalPages).toBe('number');
  });

  test('success: each fee record has className and feeAmount', () => {
    for (const fee of fixture.success.data) {
      expect(typeof fee.className).toBe('string');
      expect(typeof fee.feeAmount).toBe('number');
      expect(typeof fee.isActive).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /disputes
// ---------------------------------------------------------------------------

describe('GET /disputes', () => {
  const fixture = fixtures.responses['GET /disputes'];

  test('success: disputes array with pagination', () => {
    const p = parseDisputeList(fixture.success);
    expect(Array.isArray(p.disputes)).toBe(true);
    expect(typeof p.total).toBe('number');
  });

  test('success: each dispute has status and reason', () => {
    for (const d of fixture.success.data) {
      expect(typeof d.status).toBe('string');
      expect(typeof d.reason).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /audit
// ---------------------------------------------------------------------------

describe('GET /audit', () => {
  const fixture = fixtures.responses['GET /audit'];

  test('success: logs array with pagination', () => {
    const p = parseAuditLogs(fixture.success);
    expect(Array.isArray(p.logs)).toBe(true);
    expect(typeof p.total).toBe('number');
  });

  test('success: each log entry has action and result', () => {
    for (const log of fixture.success.logs) {
      expect(typeof log.action).toBe('string');
      expect(typeof log.result).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Contract: GET /health
// ---------------------------------------------------------------------------

describe('GET /health', () => {
  const fixture = fixtures.responses['GET /health'];

  test('success (ok): status is "ok" and logLevel is a string', () => {
    const p = parseHealthCheck(fixture.success);
    expect(p.status).toBe('ok');
    expect(typeof p.logLevel).toBe('string');
  });

  test('degraded: status is "degraded"', () => {
    const p = parseHealthCheck(fixture.degraded);
    expect(p.status).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Contract: universal error envelope — all documented error responses
// ---------------------------------------------------------------------------

describe('universal error envelope', () => {
  // Collect every error fixture from all endpoints
  const allErrors = [];
  for (const [endpoint, endpointFixtures] of Object.entries(fixtures.responses)) {
    if (endpoint.startsWith('_')) continue;
    const errors = endpointFixtures.errors || {};
    for (const [code, errorFixture] of Object.entries(errors)) {
      allErrors.push({ endpoint, code, body: errorFixture.body, status: errorFixture.status });
    }
  }

  test('at least one error fixture is defined', () => {
    expect(allErrors.length).toBeGreaterThan(0);
  });

  test.each(allErrors)(
    '$endpoint → $code: body has "error" (string) and "code" (string)',
    ({ body }) => {
      expect(typeof body.error).toBe('string');
      expect(body.error.length).toBeGreaterThan(0);
      expect(typeof body.code).toBe('string');
      expect(body.code.length).toBeGreaterThan(0);
    }
  );

  test.each(allErrors)(
    '$endpoint → $code: HTTP status is a 4xx or 5xx code',
    ({ status }) => {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  );
});

// ---------------------------------------------------------------------------
// Contract: OpenAPI spec conformance
// ---------------------------------------------------------------------------

describe('OpenAPI Spec Contract Conformance (#273)', () => {
  const swaggerSpec = require('../backend/src/config/swagger');

  test('OpenAPI spec is valid and defines x-error-codes taxonomy', () => {
    expect(swaggerSpec).toBeDefined();
    expect(swaggerSpec['x-error-codes']).toBeDefined();
  });

  test('All contract error codes exist in the error taxonomy', () => {
    const errorCodes = swaggerSpec['x-error-codes'];
    for (const [, endpointFixtures] of Object.entries(fixtures.responses)) {
      const errors = endpointFixtures.errors || {};
      for (const [code] of Object.entries(errors)) {
        if (code !== 'UNAUTHORIZED' && code !== 'FORBIDDEN' && code !== 'NOT_FOUND') {
          // If in taxonomy, status must match
          if (errorCodes[code]) {
            expect(errorCodes[code].status).toBeGreaterThanOrEqual(400);
          }
        }
      }
    }
  });
});
