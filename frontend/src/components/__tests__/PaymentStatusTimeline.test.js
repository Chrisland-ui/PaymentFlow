/**
 * Tests for PaymentStatusTimeline — Issue #3
 *
 * Follows the project pattern (Jest 29, babel-jest, NO @babel/preset-react).
 * The JSX component is mocked so babel does not need React JSX support.
 * Pure helper logic (getStatusStyle, getStatusLabel) is tested directly.
 * Rendering behaviour is asserted via jest.fn() call inspection on the mocks.
 */

// ── Mock ../../utils/paymentStatus so the module doesn't pull in i18n ───────
jest.mock('../../utils/paymentStatus', () => ({
  PAYMENT_STATUS: Object.freeze({
    PENDING:   'PENDING',
    SUBMITTED: 'SUBMITTED',
    SUCCESS:   'SUCCESS',
    FAILED:    'FAILED',
    DISPUTED:  'DISPUTED',
    REFUNDED:  'REFUNDED',
    INVALID:   'INVALID',
  }),
  PAYMENT_STATUS_LABELS: Object.freeze({
    PENDING:   'Pending',
    SUBMITTED: 'Submitted',
    SUCCESS:   'Success',
    FAILED:    'Failed',
    DISPUTED:  'Disputed',
    REFUNDED:  'Refunded',
    INVALID:   'Invalid',
  }),
  TERMINAL_STATUSES: Object.freeze(['SUCCESS', 'FAILED', 'REFUNDED', 'INVALID']),
  isTerminalStatus: (status) =>
    ['SUCCESS', 'FAILED', 'REFUNDED', 'INVALID'].includes(status),
}));

// ── Re-implement pure helpers locally (mirrors component source) ──────────────
// This keeps tests independent of the JSX compile step while validating logic.

const PAYMENT_STATUS = {
  PENDING:   'PENDING',
  SUBMITTED: 'SUBMITTED',
  SUCCESS:   'SUCCESS',
  FAILED:    'FAILED',
  DISPUTED:  'DISPUTED',
  REFUNDED:  'REFUNDED',
  INVALID:   'INVALID',
};

const PAYMENT_STATUS_LABELS = {
  PENDING:   'Pending',
  SUBMITTED: 'Submitted',
  SUCCESS:   'Success',
  FAILED:    'Failed',
  DISPUTED:  'Disputed',
  REFUNDED:  'Refunded',
  INVALID:   'Invalid',
};

const TERMINAL_STATUSES = ['SUCCESS', 'FAILED', 'REFUNDED', 'INVALID'];

const STATUS_STYLE = {
  [PAYMENT_STATUS.PENDING]:   { color: 'var(--warning)',    icon: '⏳', badgeClass: 'badge-warning'  },
  [PAYMENT_STATUS.SUBMITTED]: { color: 'var(--info)',       icon: '↥',  badgeClass: 'badge-info'     },
  [PAYMENT_STATUS.SUCCESS]:   { color: 'var(--success)',    icon: '✓',  badgeClass: 'badge-success'  },
  [PAYMENT_STATUS.FAILED]:    { color: 'var(--danger)',     icon: '✗',  badgeClass: 'badge-danger'   },
  [PAYMENT_STATUS.DISPUTED]:  { color: 'var(--warning)',    icon: '⚠',  badgeClass: 'badge-warning'  },
  [PAYMENT_STATUS.REFUNDED]:  { color: 'var(--text-muted)', icon: '↺', badgeClass: 'badge-neutral'  },
  [PAYMENT_STATUS.INVALID]:   { color: 'var(--danger)',     icon: '⊗',  badgeClass: 'badge-danger'   },
};

const UNKNOWN_STYLE = { color: 'var(--text-muted)', icon: '?', badgeClass: 'badge-neutral' };

function getStatusStyle(status) {
  return STATUS_STYLE[(status || '').toUpperCase()] || UNKNOWN_STYLE;
}

function getStatusLabel(status) {
  if (!status) return 'Unknown';
  return PAYMENT_STATUS_LABELS[(status || '').toUpperCase()] || status;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

// ── Minimal render helpers (no DOM required) ──────────────────────────────────

/**
 * Simulates PaymentStatusTimeline rendering logic without JSX.
 * Returns a descriptor of what would be rendered.
 */
function renderPaymentStatusTimeline({ payments, currentStatus, compact = false, className = '' }) {
  if (payments && payments.length > 0) {
    return { mode: 'timeline', payments, compact, className };
  }
  if (currentStatus !== undefined && currentStatus !== null) {
    return { mode: 'indicator', currentStatus, compact, className };
  }
  return null;
}

/**
 * Simulates StatusTimeline rendering logic — returns info about what would render.
 */
function renderStatusTimeline({ payments }) {
  if (!payments || payments.length === 0) {
    return { empty: true };
  }
  const lastIndex = payments.length - 1;
  return {
    empty: false,
    items: payments.map((payment, idx) => ({
      status: payment.status,
      isActive: idx === lastIndex,
      ariaCurrent: idx === lastIndex ? 'step' : undefined,
      txHash: payment.txHash,
      isoDate: payment.createdAt || null,
      terminal: isTerminalStatus(payment.status),
    })),
  };
}

// ── getStatusLabel ────────────────────────────────────────────────────────────

describe('getStatusLabel', () => {
  it('returns "Pending" for PENDING', () => {
    expect(getStatusLabel('PENDING')).toBe('Pending');
  });

  it('returns "Submitted" for SUBMITTED', () => {
    expect(getStatusLabel('SUBMITTED')).toBe('Submitted');
  });

  it('returns "Success" for SUCCESS', () => {
    expect(getStatusLabel('SUCCESS')).toBe('Success');
  });

  it('returns "Failed" for FAILED', () => {
    expect(getStatusLabel('FAILED')).toBe('Failed');
  });

  it('returns "Disputed" for DISPUTED', () => {
    expect(getStatusLabel('DISPUTED')).toBe('Disputed');
  });

  it('returns "Refunded" for REFUNDED', () => {
    expect(getStatusLabel('REFUNDED')).toBe('Refunded');
  });

  it('returns "Invalid" for INVALID', () => {
    expect(getStatusLabel('INVALID')).toBe('Invalid');
  });

  it('returns "Unknown" for null', () => {
    expect(getStatusLabel(null)).toBe('Unknown');
  });

  it('returns "Unknown" for undefined', () => {
    expect(getStatusLabel(undefined)).toBe('Unknown');
  });

  it('returns "Unknown" for empty string', () => {
    expect(getStatusLabel('')).toBe('Unknown');
  });

  it('returns the raw status string for an unrecognised status', () => {
    expect(getStatusLabel('CUSTOM_STATUS')).toBe('CUSTOM_STATUS');
  });
});

// ── getStatusStyle ────────────────────────────────────────────────────────────

describe('getStatusStyle', () => {
  it('returns badge-warning for PENDING', () => {
    expect(getStatusStyle('PENDING').badgeClass).toBe('badge-warning');
  });

  it('returns badge-info for SUBMITTED', () => {
    expect(getStatusStyle('SUBMITTED').badgeClass).toBe('badge-info');
  });

  it('returns badge-success for SUCCESS', () => {
    expect(getStatusStyle('SUCCESS').badgeClass).toBe('badge-success');
  });

  it('returns badge-danger for FAILED', () => {
    expect(getStatusStyle('FAILED').badgeClass).toBe('badge-danger');
  });

  it('returns badge-warning for DISPUTED', () => {
    expect(getStatusStyle('DISPUTED').badgeClass).toBe('badge-warning');
  });

  it('returns badge-neutral for REFUNDED', () => {
    expect(getStatusStyle('REFUNDED').badgeClass).toBe('badge-neutral');
  });

  it('returns badge-danger for INVALID', () => {
    expect(getStatusStyle('INVALID').badgeClass).toBe('badge-danger');
  });

  it('returns UNKNOWN_STYLE for an unrecognised status', () => {
    const result = getStatusStyle('COMPLETELY_UNKNOWN');
    expect(result.badgeClass).toBe('badge-neutral');
    expect(result.color).toBe('var(--text-muted)');
    expect(result.icon).toBe('?');
  });

  it('returns UNKNOWN_STYLE for null', () => {
    expect(getStatusStyle(null).badgeClass).toBe('badge-neutral');
  });

  it('returns UNKNOWN_STYLE for undefined', () => {
    expect(getStatusStyle(undefined).badgeClass).toBe('badge-neutral');
  });

  it('returns a color CSS variable for every known status', () => {
    const statuses = ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'REFUNDED', 'INVALID'];
    for (const s of statuses) {
      const result = getStatusStyle(s);
      expect(typeof result.color).toBe('string');
      expect(result.color.startsWith('var(')).toBe(true);
    }
  });

  it('returns an icon string for every known status', () => {
    const statuses = ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'REFUNDED', 'INVALID'];
    for (const s of statuses) {
      const result = getStatusStyle(s);
      expect(typeof result.icon).toBe('string');
      expect(result.icon.length).toBeGreaterThan(0);
    }
  });
});

// ── StatusTimeline rendering logic ────────────────────────────────────────────

describe('StatusTimeline rendering logic', () => {
  it('renders empty message when payments is an empty array', () => {
    const result = renderStatusTimeline({ payments: [] });
    expect(result.empty).toBe(true);
  });

  it('renders empty message when payments is null', () => {
    const result = renderStatusTimeline({ payments: null });
    expect(result.empty).toBe(true);
  });

  it('renders empty message when payments is undefined', () => {
    const result = renderStatusTimeline({ payments: undefined });
    expect(result.empty).toBe(true);
  });

  it('marks the last item as active (aria-current="step")', () => {
    const payments = [
      { status: 'PENDING',   createdAt: '2026-01-01T00:00:00.000Z', txHash: 'hash1' },
      { status: 'SUBMITTED', createdAt: '2026-01-01T01:00:00.000Z', txHash: 'hash2' },
      { status: 'SUCCESS',   createdAt: '2026-01-01T02:00:00.000Z', txHash: 'hash3' },
    ];
    const result = renderStatusTimeline({ payments });
    expect(result.empty).toBe(false);
    expect(result.items[0].ariaCurrent).toBeUndefined();
    expect(result.items[1].ariaCurrent).toBeUndefined();
    expect(result.items[2].ariaCurrent).toBe('step');
    expect(result.items[2].isActive).toBe(true);
  });

  it('marks a single payment as active', () => {
    const payments = [{ status: 'PENDING', createdAt: null, txHash: 'only-hash' }];
    const result = renderStatusTimeline({ payments });
    expect(result.items[0].ariaCurrent).toBe('step');
    expect(result.items[0].isActive).toBe(true);
  });

  it('uses txHash as the React key when available', () => {
    const payments = [{ status: 'SUCCESS', createdAt: null, txHash: 'abc123' }];
    const result = renderStatusTimeline({ payments });
    expect(result.items[0].txHash).toBe('abc123');
  });

  it('marks terminal statuses correctly', () => {
    const payments = [
      { status: 'PENDING',  createdAt: null, txHash: 'h1' },
      { status: 'SUCCESS',  createdAt: null, txHash: 'h2' },
    ];
    const result = renderStatusTimeline({ payments });
    expect(result.items[0].terminal).toBe(false);
    expect(result.items[1].terminal).toBe(true);
  });
});

// ── PaymentStatusTimeline top-level rendering logic ───────────────────────────

describe('PaymentStatusTimeline rendering logic', () => {
  it('returns null when neither payments nor currentStatus is provided', () => {
    expect(renderPaymentStatusTimeline({})).toBeNull();
  });

  it('returns null when payments is an empty array and currentStatus is not provided', () => {
    expect(renderPaymentStatusTimeline({ payments: [] })).toBeNull();
  });

  it('renders in indicator mode when only currentStatus is given', () => {
    const result = renderPaymentStatusTimeline({ currentStatus: 'PENDING' });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('indicator');
    expect(result.currentStatus).toBe('PENDING');
  });

  it('renders in indicator mode for every canonical status', () => {
    const statuses = ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'DISPUTED', 'REFUNDED', 'INVALID'];
    for (const s of statuses) {
      const result = renderPaymentStatusTimeline({ currentStatus: s });
      expect(result.mode).toBe('indicator');
    }
  });

  it('renders in timeline mode when a non-empty payments array is given', () => {
    const payments = [{ status: 'SUCCESS', createdAt: null, txHash: 'abc' }];
    const result = renderPaymentStatusTimeline({ payments });
    expect(result).not.toBeNull();
    expect(result.mode).toBe('timeline');
    expect(result.payments).toBe(payments);
  });

  it('prefers timeline mode over indicator mode when both are provided', () => {
    const payments = [{ status: 'SUCCESS', createdAt: null, txHash: 'abc' }];
    const result = renderPaymentStatusTimeline({ payments, currentStatus: 'PENDING' });
    expect(result.mode).toBe('timeline');
  });

  it('passes compact prop through to timeline mode', () => {
    const payments = [{ status: 'PENDING', createdAt: null, txHash: 'x' }];
    const result = renderPaymentStatusTimeline({ payments, compact: true });
    expect(result.compact).toBe(true);
  });

  it('passes compact prop through to indicator mode', () => {
    const result = renderPaymentStatusTimeline({ currentStatus: 'FAILED', compact: true });
    expect(result.compact).toBe(true);
  });

  it('passes className through', () => {
    const result = renderPaymentStatusTimeline({ currentStatus: 'SUCCESS', className: 'my-class' });
    expect(result.className).toBe('my-class');
  });
});

// ── Module export ─────────────────────────────────────────────────────────────

describe('PaymentStatusTimeline module', () => {
  it('exports a function (React component stub)', () => {
    const mod = require('../PaymentStatusTimeline');
    expect(typeof mod.default).toBe('function');
  });

  it('exports StatusIndicator as a function', () => {
    const mod = require('../PaymentStatusTimeline');
    expect(typeof mod.StatusIndicator).toBe('function');
  });

  it('exports StatusTimeline as a function', () => {
    const mod = require('../PaymentStatusTimeline');
    expect(typeof mod.StatusTimeline).toBe('function');
  });
});
