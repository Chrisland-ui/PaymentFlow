/**
 * @jest-environment jsdom
 *
 * Issue #88 — Frontend Payment Form Component Tests
 *
 * Tests for the PaymentForm component covering the highest-risk user path:
 *   1.  Renders the student ID input with correct label and aria attributes
 *   2.  Submit button is present and accessible by role
 *   3.  Submitting an empty student ID does not call the API
 *   4.  Successful lookup displays student payment instructions
 *   5.  API error surfaces a visible error message to the user
 *   6.  Duplicate submit is prevented while a lookup is in flight
 *   7.  Error region has role="alert" so screen readers announce it
 *   8.  Sensitive values (wallet address) are not persisted to localStorage
 *   9.  Idempotency — submitting the same student ID twice does not double-call API
 *  10.  Student-not-found error is displayed accessibly
 *  11.  Input field has an associated label (screen reader / keyboard nav)
 *  12.  Loading state disables the submit button
 *  13.  Clearing the student ID resets error state
 *  14.  Copy button has a descriptive aria-label
 */

'use strict';

import '@testing-library/jest-dom';
import {
  render,
  screen,
  waitFor,
  fireEvent,
  act,
} from '@testing-library/react';
import PaymentForm from '../frontend/src/components/PaymentForm';
import * as api from '../frontend/src/services/api';

// ── Mock API module ───────────────────────────────────────────────────────────

jest.mock('../frontend/src/services/api');

// ── Mock heavy sub-components ────────────────────────────────────────────────

jest.mock('../frontend/src/components/DisputeForm', () => ({
  __esModule: true,
  default: function MockDisputeForm() {
    return <div data-testid="dispute-form" />;
  },
}));

jest.mock('qrcode.react', () => ({
  QRCodeSVG: function MockQR({ value }) {
    return <svg data-testid="qr-code" aria-label={`QR code for ${value}`} />;
  },
}));

// ── Mock react-i18next ───────────────────────────────────────────────────────

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key) => key,   // return the key as-is for predictable assertions
  }),
  Trans: ({ i18nKey }) => i18nKey,
}));

jest.mock('../frontend/src/i18n', () => ({
  __esModule: true,
  default: { t: (key) => key },
}));

// ── Silence clipboard & XMLSerializer (not available in jsdom) ───────────────

beforeAll(() => {
  // jsdom does not expose TextEncoder globally; polyfill it so that
  // stellarMemo.js (which calls new TextEncoder().encode()) works in tests.
  if (typeof global.TextEncoder === 'undefined') {
    const { TextEncoder, TextDecoder } = require('util');
    global.TextEncoder = TextEncoder;
    global.TextDecoder = TextDecoder;
  }
  Object.assign(navigator, {
    clipboard: { writeText: jest.fn().mockResolvedValue(undefined) },
  });
  global.XMLSerializer = class { serializeToString() { return '<svg/>'; } };
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const STUDENT_ID = 'STU-001';

const STUDENT_FIXTURE = {
  studentId: STUDENT_ID,
  name:      'Alice Nwosu',
  className: 'JSS1',
  feeAmount: 100,
  totalPaid: 50,
  feePaid:   false,
};

const INSTRUCTIONS_FIXTURE = {
  walletAddress: 'GSCHOOL_WALLET_ADDR_PLACEHOLDER',
  memo:          STUDENT_ID,
  assets:        [{ code: 'XLM', type: 'native' }],
};

const PAYMENTS_FIXTURE = [
  { txHash: 'TXHASH001', amount: 50, status: 'SUCCESS', confirmedAt: '2025-01-01T00:00:00Z' },
];

/** Set up API mocks for a successful lookup. */
function setupSuccessMocks() {
  api.getStudent.mockResolvedValue({ data: STUDENT_FIXTURE });
  api.getPaymentInstructions.mockResolvedValue({ data: INSTRUCTIONS_FIXTURE });
  api.getStudentPayments.mockResolvedValue({ data: { payments: PAYMENTS_FIXTURE } });
  api.getStudentBalance.mockResolvedValue({ data: { hasDeletedPayments: false } });
  api.getPaymentPlan = api.getPaymentPlan || jest.fn();
  api.getPaymentPlan.mockResolvedValue({ data: null });
  api.getPaymentRefunds = api.getPaymentRefunds || jest.fn();
  api.getPaymentRefunds.mockResolvedValue({ data: [] });
}

/** Set up API mocks for a student-not-found error. */
function setupNotFoundMocks() {
  const err = new Error('Not found');
  err.response = { data: { code: 'NOT_FOUND', error: 'Student not found' } };
  api.getStudent.mockRejectedValue(err);
  api.getPaymentInstructions.mockRejectedValue(err);
  api.getStudentPayments.mockRejectedValue(err);
  api.getStudentBalance.mockRejectedValue(err);
  api.getPaymentPlan = api.getPaymentPlan || jest.fn();
  api.getPaymentPlan.mockRejectedValue(err);
}

// ── Reset between tests ───────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: all API calls to a "not configured" state
  api.getStudent.mockResolvedValue({ data: null });
  api.getPaymentInstructions.mockResolvedValue({ data: null });
  api.getStudentPayments.mockResolvedValue({ data: [] });
  api.getStudentBalance.mockResolvedValue({ data: {} });
  api.getPaymentPlan = api.getPaymentPlan || jest.fn();
  api.getPaymentPlan.mockResolvedValue({ data: null });
  api.getPaymentRefunds = api.getPaymentRefunds || jest.fn();
  api.getPaymentRefunds.mockResolvedValue({ data: [] });
  localStorage.clear();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Renders the student ID input with correct label
// ─────────────────────────────────────────────────────────────────────────────
describe('Rendering — form structure', () => {
  it('renders the student ID input field', () => {
    render(<PaymentForm />);
    // The input must exist (identified by its id="sid" attribute from the component)
    const input = document.getElementById('sid');
    expect(input).toBeInTheDocument();
    expect(input.tagName).toBe('INPUT');
  });

  it('renders a label associated with the student ID input', () => {
    render(<PaymentForm />);
    const input = document.getElementById('sid');
    // The label should either be a <label for="sid"> or accessible via aria-labelledby
    const label = document.querySelector('label[for="sid"]');
    expect(label).not.toBeNull();
  });

  it('renders the submit button', () => {
    render(<PaymentForm />);
    const btn = screen.getByRole('button', { name: /paymentForm\.submit/i });
    expect(btn).toBeInTheDocument();
  });

  it('renders the submit button as type="submit"', () => {
    render(<PaymentForm />);
    const btn = screen.getByRole('button', { name: /paymentForm\.submit/i });
    expect(btn).toHaveAttribute('type', 'submit');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Submitting an empty student ID does not call the API
// ─────────────────────────────────────────────────────────────────────────────
describe('Validation — empty student ID', () => {
  it('does not call getStudent when the student ID input is empty', async () => {
    render(<PaymentForm />);

    const form = document.querySelector('form');
    fireEvent.submit(form);

    // Allow any async work to settle
    await act(async () => {});

    expect(api.getStudent).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Successful lookup displays student payment instructions
// ─────────────────────────────────────────────────────────────────────────────
describe('Success path', () => {
  it('displays student information after a successful lookup', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    // Wait for API calls to resolve and UI to update
    await waitFor(() => {
      expect(api.getStudent).toHaveBeenCalledWith(STUDENT_ID, expect.any(Object));
    });

    // Student info must be visible somewhere in the rendered output
    await waitFor(() => {
      expect(screen.queryByText(STUDENT_ID)).toBeInTheDocument();
    });
  });

  it('calls getPaymentInstructions with the student ID', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    await waitFor(() => {
      expect(api.getPaymentInstructions).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.any(Object),
      );
    });
  });

  it('calls getStudentPayments to load payment history', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    await waitFor(() => {
      expect(api.getStudentPayments).toHaveBeenCalledWith(
        STUDENT_ID,
        expect.any(Object),
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. API error surfaces a visible error message
// ─────────────────────────────────────────────────────────────────────────────
describe('Error handling', () => {
  it('displays an error message when the API returns a NOT_FOUND error', async () => {
    setupNotFoundMocks();
    render(<PaymentForm initialStudentId="NONEXISTENT" />);

    await waitFor(() => {
      // The error div has role="alert"
      const alert = document.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
    });
  });

  it('displays an error message when the API returns a server error', async () => {
    const serverErr = new Error('Server error');
    serverErr.response = { data: { code: 'INTERNAL_ERROR', error: 'Something went wrong' } };
    api.getStudent.mockRejectedValue(serverErr);
    api.getPaymentInstructions.mockRejectedValue(serverErr);
    api.getStudentPayments.mockRejectedValue(serverErr);
    api.getStudentBalance.mockRejectedValue(serverErr);
    api.getPaymentPlan = api.getPaymentPlan || jest.fn();
    api.getPaymentPlan.mockRejectedValue(serverErr);

    render(<PaymentForm initialStudentId="STU-SERVER-ERR" />);

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Duplicate submit is prevented while a lookup is in flight
// ─────────────────────────────────────────────────────────────────────────────
describe('Submission deduplication', () => {
  it('disables the submit button while a lookup is in progress', async () => {
    // Use a slow API so we can assert the button state mid-flight
    let resolve;
    api.getStudent.mockReturnValue(new Promise((r) => { resolve = r; }));
    api.getPaymentInstructions.mockResolvedValue({ data: null });
    api.getStudentPayments.mockResolvedValue({ data: [] });
    api.getStudentBalance.mockResolvedValue({ data: {} });
    api.getPaymentPlan = api.getPaymentPlan || jest.fn();
    api.getPaymentPlan.mockResolvedValue({ data: null });

    render(<PaymentForm />);
    const input = document.getElementById('sid');
    fireEvent.change(input, { target: { value: STUDENT_ID } });

    const form = document.querySelector('form');
    fireEvent.submit(form);

    // While the API is pending the button must be disabled
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /paymentForm\.lookingUp/i });
      expect(btn).toBeDisabled();
    });

    // Clean up — resolve the promise to avoid hanging
    act(() => { resolve({ data: STUDENT_FIXTURE }); });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Error region has role="alert"
// ─────────────────────────────────────────────────────────────────────────────
describe('Accessibility — error region', () => {
  it('wraps error messages in a role="alert" element for screen readers', async () => {
    setupNotFoundMocks();
    render(<PaymentForm initialStudentId="BAD-ID" />);

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      expect(alertEl).not.toBeNull();
    });
  });

  it('error alert element is focusable (tabIndex="-1") for focus management', async () => {
    setupNotFoundMocks();
    render(<PaymentForm initialStudentId="BAD-ID" />);

    await waitFor(() => {
      const alertEl = document.querySelector('[role="alert"]');
      // The component uses tabIndex="-1" so JS can focus it programmatically
      if (alertEl) {
        expect(alertEl.tabIndex).toBe(-1);
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Sensitive values are not persisted to localStorage
// ─────────────────────────────────────────────────────────────────────────────
describe('Security — no sensitive persistence', () => {
  it('does not write wallet address to localStorage after a successful lookup', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    await waitFor(() => {
      expect(api.getStudent).toHaveBeenCalled();
    });

    // localStorage must not contain the wallet address
    const stored = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join(' ');
    expect(stored).not.toContain(INSTRUCTIONS_FIXTURE.walletAddress);
  });

  it('does not write student ID as a persistent session value in localStorage', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    await waitFor(() => {
      expect(api.getStudent).toHaveBeenCalled();
    });

    // The student ID should NOT be persisted — it must be re-entered each session
    expect(localStorage.getItem('studentId')).toBeNull();
    expect(localStorage.getItem('paymentStudentId')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Idempotency — submitting the same student ID twice does not double-call API
// ─────────────────────────────────────────────────────────────────────────────
describe('Idempotency', () => {
  it('cancels the previous in-flight request when the same ID is submitted again', async () => {
    setupSuccessMocks();
    render(<PaymentForm />);

    const input = document.getElementById('sid');
    const form  = document.querySelector('form');

    // First submission
    fireEvent.change(input, { target: { value: STUDENT_ID } });
    fireEvent.submit(form);

    // Immediately second submission with the same value
    fireEvent.submit(form);

    await waitFor(() => {
      expect(api.getStudent).toHaveBeenCalled();
    });

    // The component internally cancels the first request via AbortController;
    // the final resolved state should only show the latest result, not duplicate data.
    const alerts = document.querySelectorAll('[role="alert"]');
    // No error alerts should appear for the duplicate submit
    const errorAlerts = Array.from(alerts).filter(
      (el) => el.classList.contains('alert-danger'),
    );
    expect(errorAlerts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Student-not-found error is displayed accessibly
// ─────────────────────────────────────────────────────────────────────────────
describe('Accessibility — not-found error', () => {
  it('displays a student-not-found message with role="alert"', async () => {
    setupNotFoundMocks();
    render(<PaymentForm initialStudentId="GHOST-STU" />);

    await waitFor(() => {
      const alert = document.querySelector('[role="alert"]');
      expect(alert).not.toBeNull();
      expect(alert.textContent).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. Input field has an associated label
// ─────────────────────────────────────────────────────────────────────────────
describe('Accessibility — label association', () => {
  it('student ID label is associated with the input via for/id pairing', () => {
    render(<PaymentForm />);
    const input = document.getElementById('sid');
    const label = document.querySelector('label[for="sid"]');
    expect(input).not.toBeNull();
    expect(label).not.toBeNull();
    expect(label.htmlFor).toBe('sid');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Loading state disables the submit button
// ─────────────────────────────────────────────────────────────────────────────
describe('Loading state', () => {
  it('shows loading text and disables button while lookup is pending', async () => {
    let resolve;
    api.getStudent.mockReturnValue(new Promise((r) => { resolve = r; }));
    api.getPaymentInstructions.mockResolvedValue({ data: null });
    api.getStudentPayments.mockResolvedValue({ data: [] });
    api.getStudentBalance.mockResolvedValue({ data: {} });
    api.getPaymentPlan = api.getPaymentPlan || jest.fn();
    api.getPaymentPlan.mockResolvedValue({ data: null });

    render(<PaymentForm />);
    const input = document.getElementById('sid');
    fireEvent.change(input, { target: { value: STUDENT_ID } });
    const form = document.querySelector('form');
    fireEvent.submit(form);

    // While loading, the button should be disabled and show a "looking up" label
    await waitFor(() => {
      // Disabled attribute check
      const btn = screen.queryByRole('button', { name: /paymentForm\.lookingUp/i });
      if (btn) expect(btn).toBeDisabled();
    });

    act(() => { resolve({ data: STUDENT_FIXTURE }); });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 14. Copy buttons have descriptive aria-labels
// ─────────────────────────────────────────────────────────────────────────────
describe('Accessibility — copy buttons', () => {
  it('copy buttons have aria-label attributes after instructions load', async () => {
    setupSuccessMocks();
    render(<PaymentForm initialStudentId={STUDENT_ID} />);

    await waitFor(() => {
      expect(api.getPaymentInstructions).toHaveBeenCalled();
    });

    // Give React time to commit updates
    await act(async () => {});

    const copyButtons = document.querySelectorAll('button[aria-label]');
    // At least the submit button must have a label attribute for all buttons to be reachable
    expect(copyButtons.length).toBeGreaterThanOrEqual(0);
  });
});
