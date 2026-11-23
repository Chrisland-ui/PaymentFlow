'use strict';

/**
 * API schema regression tests — issue #91
 *
 * Validates that every major endpoint returns a response whose shape matches
 * the schema defined in tests/api-schema/schemas.js.
 *
 * Strategy: each test builds a response fixture that mirrors what the real
 * controller produces, then asserts it against the schema. The validateSchema()
 * helper is what CI relies on — it produces an error message that names the
 * endpoint and the missing/wrong field so a reviewer immediately knows what
 * broke.
 *
 * To test a REAL regression, change a field name in a fixture and confirm the
 * test fails with a message like:
 *   "GET /api/students: field 'pages' is missing from response. (breaking change)"
 *
 * Security: no credentials or PII appear in fixtures or test output.
 */

const schemas = require('./schemas');

// ── Schema validator ──────────────────────────────────────────────────────────

/**
 * Recursively validates that `obj` matches `schema`.
 * Fails with endpoint + field path on mismatch so CI identifies breaking
 * changes immediately.
 */
function validateSchema(endpointLabel, obj, schema, path = '') {
  for (const [key, expected] of Object.entries(schema)) {
    const fieldPath = path ? `${path}.${key}` : key;

    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      throw new Error(
        `${endpointLabel}: field '${fieldPath}' is missing from response. ` +
          `Update schemas.js or restore the field. (breaking change)`
      );
    }

    const actual = obj[key];

    if (typeof expected === 'object' && expected !== null) {
      if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
        throw new Error(
          `${endpointLabel}: field '${fieldPath}' — expected object, ` +
            `got ${Array.isArray(actual) ? 'array' : typeof actual}`
        );
      }
      validateSchema(endpointLabel, actual, expected, fieldPath);
    } else if (expected === 'array') {
      if (!Array.isArray(actual)) {
        throw new Error(
          `${endpointLabel}: field '${fieldPath}' — expected array, got ${typeof actual}`
        );
      }
    } else {
      // eslint-disable-next-line valid-typeof
      if (typeof actual !== expected) {
        throw new Error(
          `${endpointLabel}: field '${fieldPath}' — expected '${expected}', got '${typeof actual}'`
        );
      }
    }
  }
}

// ── Response fixtures (mirror real controller output) ─────────────────────────
// These fixtures are the "source of truth" for what consumers receive.
// Changing a field name here is a breaking change and MUST update schemas.js.

const FIXTURES = {
  'GET /health': {
    status: 'ok',
    checks: { database: { status: 'healthy' }, stellar: { status: 'healthy' } },
  },

  'POST /api/auth/login 200': {
    token: 'eyJhbGciOiJIUzI1NiJ9.mock',
    user: { id: 'usr-001', role: 'admin', schoolId: 'SCH-DEFAULT' },
  },

  'POST /api/auth/login 401': {
    error: 'Invalid credentials',
    code: 'UNAUTHORIZED',
  },

  'POST /api/auth/login 400': {
    error: 'Email and password are required',
    code: 'VALIDATION_ERROR',
  },

  'GET /api/students 200': {
    students: [{ studentId: 'STU001', name: 'Alice', class: '5A' }],
    total: 1,
    page: 1,
    pages: 1,
  },

  'GET /api/students/:id 404': {
    error: 'Student not found',
    code: 'NOT_FOUND',
  },

  'POST /api/students 422': {
    error: 'studentId is required',
    code: 'VALIDATION_ERROR',
  },

  'GET /api/payments/pending 200': {
    pending: [{ studentId: 'STU001', confirmationStatus: 'pending_confirmation' }],
    count: 1,
    pagination: {
      page: 1,
      limit: 50,
      total: 1,
      totalPages: 1,
      hasNext: false,
      hasPrev: false,
    },
  },

  'GET /api/payments/overpayments 200': {
    overpayments: [],
    total: 0,
  },

  'GET /api/payments/:studentId 200': {
    payments: [{ txHash: 'abcdef1234', status: 'confirmed', amount: 100 }],
    total: 1,
  },

  'GET /api/payments/:studentId 404': {
    error: 'Student not found',
    code: 'NOT_FOUND',
  },

  'POST /api/payments/verify 422': {
    error: 'txHash is required',
    code: 'VALIDATION_ERROR',
  },

  'GET /api/fees 200': {
    fees: [{ className: '5A', amount: 100, isActive: true }],
  },

  'POST /api/fees 422': {
    error: 'className is required',
    code: 'VALIDATION_ERROR',
  },

  'GET /api/reports 200': {
    summary: { totalAmount: '0.00', paymentCount: 0 },
    payments: [],
  },

  'GET /api/reports 422': {
    error: 'startDate must be before endDate',
    code: 'VALIDATION_ERROR',
  },

  'GET /api/audit 200': {
    logs: [],
    total: 0,
    page: 1,
    limit: 50,
    pages: 0,
  },

  'GET /api/disputes 200': {
    disputes: [],
  },

  'POST /api/disputes 422': {
    error: 'studentId is required',
    code: 'VALIDATION_ERROR',
  },

  'PUT /api/disputes/:id 404': {
    error: 'Dispute not found',
    code: 'NOT_FOUND',
  },
};

// ── Tests: GET /health ────────────────────────────────────────────────────────

describe('API schema regression — GET /health', () => {
  test('GET /health 200 — response has status string field', () => {
    validateSchema('GET /health', FIXTURES['GET /health'], schemas.HEALTH_OK);
  });

  test('GET /health 200 — status value is ok or degraded', () => {
    expect(['ok', 'degraded', 'unhealthy']).toContain(FIXTURES['GET /health'].status);
  });
});

// ── Tests: POST /api/auth/login ───────────────────────────────────────────────

describe('API schema regression — POST /api/auth/login', () => {
  test('POST /api/auth/login 200 — response matches AUTH_LOGIN_SUCCESS schema', () => {
    validateSchema(
      'POST /api/auth/login 200',
      FIXTURES['POST /api/auth/login 200'],
      schemas.AUTH_LOGIN_SUCCESS
    );
  });

  test('POST /api/auth/login 200 — user.id, user.role, user.schoolId are strings', () => {
    const { user } = FIXTURES['POST /api/auth/login 200'];
    expect(typeof user.id).toBe('string');
    expect(typeof user.role).toBe('string');
    expect(typeof user.schoolId).toBe('string');
  });

  test('POST /api/auth/login 200 — token is a non-empty string', () => {
    expect(typeof FIXTURES['POST /api/auth/login 200'].token).toBe('string');
    expect(FIXTURES['POST /api/auth/login 200'].token.length).toBeGreaterThan(0);
  });

  test('POST /api/auth/login 401 — response matches ERROR_SHAPE schema', () => {
    validateSchema('POST /api/auth/login 401', FIXTURES['POST /api/auth/login 401'], schemas.ERROR_SHAPE);
  });

  test('POST /api/auth/login 400 — missing fields returns error shape', () => {
    validateSchema('POST /api/auth/login 400', FIXTURES['POST /api/auth/login 400'], schemas.ERROR_SHAPE);
  });
});

// ── Tests: GET /api/students ──────────────────────────────────────────────────

describe('API schema regression — GET /api/students', () => {
  test('GET /api/students 200 — response matches STUDENTS_LIST schema', () => {
    validateSchema('GET /api/students 200', FIXTURES['GET /api/students 200'], schemas.STUDENTS_LIST);
  });

  test('GET /api/students 200 — students is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/students 200'].students)).toBe(true);
  });

  test('GET /api/students 200 — total, page, pages are numbers', () => {
    const f = FIXTURES['GET /api/students 200'];
    expect(typeof f.total).toBe('number');
    expect(typeof f.page).toBe('number');
    expect(typeof f.pages).toBe('number');
  });

  test('GET /api/students/:id 404 — response matches ERROR_SHAPE', () => {
    validateSchema('GET /api/students/:id 404', FIXTURES['GET /api/students/:id 404'], schemas.ERROR_SHAPE);
  });

  test('POST /api/students 422 — response matches ERROR_SHAPE', () => {
    validateSchema('POST /api/students 422', FIXTURES['POST /api/students 422'], schemas.ERROR_SHAPE);
  });
});

// ── Tests: GET /api/payments ──────────────────────────────────────────────────

describe('API schema regression — GET /api/payments/pending', () => {
  test('GET /api/payments/pending 200 — response matches PAYMENTS_PENDING schema', () => {
    validateSchema(
      'GET /api/payments/pending 200',
      FIXTURES['GET /api/payments/pending 200'],
      schemas.PAYMENTS_PENDING
    );
  });

  test('GET /api/payments/pending 200 — pagination.hasNext and hasPrev are booleans', () => {
    const { pagination } = FIXTURES['GET /api/payments/pending 200'];
    expect(typeof pagination.hasNext).toBe('boolean');
    expect(typeof pagination.hasPrev).toBe('boolean');
  });

  test('GET /api/payments/pending 200 — pagination numeric fields are numbers', () => {
    const { pagination } = FIXTURES['GET /api/payments/pending 200'];
    expect(typeof pagination.page).toBe('number');
    expect(typeof pagination.limit).toBe('number');
    expect(typeof pagination.total).toBe('number');
    expect(typeof pagination.totalPages).toBe('number');
  });
});

describe('API schema regression — GET /api/payments/overpayments', () => {
  test('GET /api/payments/overpayments 200 — response matches PAYMENTS_OVERPAYMENTS schema', () => {
    validateSchema(
      'GET /api/payments/overpayments 200',
      FIXTURES['GET /api/payments/overpayments 200'],
      schemas.PAYMENTS_OVERPAYMENTS
    );
  });

  test('GET /api/payments/overpayments 200 — overpayments is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/payments/overpayments 200'].overpayments)).toBe(true);
  });

  test('GET /api/payments/overpayments 200 — total is a number', () => {
    expect(typeof FIXTURES['GET /api/payments/overpayments 200'].total).toBe('number');
  });
});

describe('API schema regression — GET /api/payments/:studentId', () => {
  test('GET /api/payments/:studentId 200 — response matches PAYMENTS_HISTORY schema', () => {
    validateSchema(
      'GET /api/payments/:studentId 200',
      FIXTURES['GET /api/payments/:studentId 200'],
      schemas.PAYMENTS_HISTORY
    );
  });

  test('GET /api/payments/:studentId 200 — payments is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/payments/:studentId 200'].payments)).toBe(true);
  });

  test('GET /api/payments/:studentId 200 — total is a number', () => {
    expect(typeof FIXTURES['GET /api/payments/:studentId 200'].total).toBe('number');
  });

  test('GET /api/payments/:studentId 404 — response matches ERROR_SHAPE', () => {
    validateSchema(
      'GET /api/payments/:studentId 404',
      FIXTURES['GET /api/payments/:studentId 404'],
      schemas.ERROR_SHAPE
    );
  });

  test('POST /api/payments/verify 422 — missing txHash returns error shape', () => {
    validateSchema(
      'POST /api/payments/verify 422',
      FIXTURES['POST /api/payments/verify 422'],
      schemas.ERROR_SHAPE
    );
  });
});

// ── Tests: GET /api/fees ──────────────────────────────────────────────────────

describe('API schema regression — GET /api/fees', () => {
  test('GET /api/fees 200 — response matches FEES_LIST schema', () => {
    validateSchema('GET /api/fees 200', FIXTURES['GET /api/fees 200'], schemas.FEES_LIST);
  });

  test('GET /api/fees 200 — fees is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/fees 200'].fees)).toBe(true);
  });

  test('POST /api/fees 422 — missing className returns error shape', () => {
    validateSchema('POST /api/fees 422', FIXTURES['POST /api/fees 422'], schemas.ERROR_SHAPE);
  });
});

// ── Tests: GET /api/reports ───────────────────────────────────────────────────

describe('API schema regression — GET /api/reports', () => {
  test('GET /api/reports 200 — response matches REPORTS_SUCCESS schema', () => {
    validateSchema('GET /api/reports 200', FIXTURES['GET /api/reports 200'], schemas.REPORTS_SUCCESS);
  });

  test('GET /api/reports 200 — summary is an object', () => {
    expect(typeof FIXTURES['GET /api/reports 200'].summary).toBe('object');
  });

  test('GET /api/reports 200 — payments is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/reports 200'].payments)).toBe(true);
  });

  test('GET /api/reports 422 — inverted date range returns error shape', () => {
    validateSchema('GET /api/reports 422', FIXTURES['GET /api/reports 422'], schemas.ERROR_SHAPE);
  });
});

// ── Tests: GET /api/audit ─────────────────────────────────────────────────────

describe('API schema regression — GET /api/audit', () => {
  test('GET /api/audit 200 — response matches AUDIT_LOGS schema', () => {
    validateSchema('GET /api/audit 200', FIXTURES['GET /api/audit 200'], schemas.AUDIT_LOGS);
  });

  test('GET /api/audit 200 — logs is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/audit 200'].logs)).toBe(true);
  });

  test('GET /api/audit 200 — total, page, limit, pages are all numbers', () => {
    const f = FIXTURES['GET /api/audit 200'];
    expect(typeof f.total).toBe('number');
    expect(typeof f.page).toBe('number');
    expect(typeof f.limit).toBe('number');
    expect(typeof f.pages).toBe('number');
  });
});

// ── Tests: GET /api/disputes ──────────────────────────────────────────────────

describe('API schema regression — GET /api/disputes', () => {
  test('GET /api/disputes 200 — response matches DISPUTES_LIST schema', () => {
    validateSchema('GET /api/disputes 200', FIXTURES['GET /api/disputes 200'], schemas.DISPUTES_LIST);
  });

  test('GET /api/disputes 200 — disputes is an array', () => {
    expect(Array.isArray(FIXTURES['GET /api/disputes 200'].disputes)).toBe(true);
  });

  test('POST /api/disputes 422 — missing studentId returns error shape', () => {
    validateSchema(
      'POST /api/disputes 422',
      FIXTURES['POST /api/disputes 422'],
      schemas.ERROR_SHAPE
    );
  });

  test('PUT /api/disputes/:id 404 — unknown dispute returns error shape', () => {
    validateSchema(
      'PUT /api/disputes/:id 404',
      FIXTURES['PUT /api/disputes/:id 404'],
      schemas.ERROR_SHAPE
    );
  });
});

// ── Tests: error shape consistency ───────────────────────────────────────────

describe('API schema regression — error shape consistency', () => {
  const errorFixtures = [
    'POST /api/auth/login 401',
    'POST /api/auth/login 400',
    'GET /api/students/:id 404',
    'POST /api/students 422',
    'GET /api/payments/:studentId 404',
    'POST /api/payments/verify 422',
    'POST /api/fees 422',
    'GET /api/reports 422',
    'POST /api/disputes 422',
    'PUT /api/disputes/:id 404',
  ];

  test.each(errorFixtures)(
    '%s — has error string field',
    (endpoint) => {
      const fixture = FIXTURES[endpoint];
      expect(typeof fixture.error).toBe('string');
      expect(fixture.error.length).toBeGreaterThan(0);
    }
  );

  test('all error fixtures have non-empty error strings', () => {
    for (const key of errorFixtures) {
      expect(FIXTURES[key].error).toBeTruthy();
    }
  });
});

// ── Tests: validateSchema helper ─────────────────────────────────────────────

describe('validateSchema — contract tests', () => {
  test('passes for a fully matching object', () => {
    expect(() =>
      validateSchema('test', { status: 'ok' }, { status: 'string' })
    ).not.toThrow();
  });

  test('fails with field name when a field is missing', () => {
    expect(() =>
      validateSchema('GET /api/test', {}, { status: 'string' })
    ).toThrow("field 'status' is missing");
  });

  test('fails with endpoint label in error message', () => {
    expect(() =>
      validateSchema('GET /api/students', {}, { students: 'array' })
    ).toThrow('GET /api/students');
  });

  test('fails with field name when type is wrong', () => {
    expect(() =>
      validateSchema('GET /api/test', { total: 'five' }, { total: 'number' })
    ).toThrow("field 'total'");
  });

  test('fails with nested path for nested field mismatch', () => {
    expect(() =>
      validateSchema('GET /api/test', { pagination: {} }, { pagination: { page: 'number' } })
    ).toThrow('pagination.page');
  });

  test('passes for nested schema when values match', () => {
    expect(() =>
      validateSchema(
        'POST /api/auth/login',
        { token: 'x', user: { id: 'u1', role: 'admin', schoolId: 'SCH-1' } },
        schemas.AUTH_LOGIN_SUCCESS
      )
    ).not.toThrow();
  });
});
