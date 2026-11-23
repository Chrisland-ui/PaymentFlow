/**
 * @jest-environment jsdom
 *
 * Tests for issue #19 — /security-headers diagnostic page.
 *
 * Coverage:
 *  1. Header check logic (pass/fail per header)
 *  2. Render: production gate (blocks page)
 *  3. Render: non-production shows audit UI and results
 *  4. CI-accessible policy validation (checks next.config.js header values)
 */

'use strict';

import '@testing-library/jest-dom';
import { render, screen, waitFor, act } from '@testing-library/react';
import SecurityHeadersPage from '../frontend/src/pages/security-headers';

// ── Stub global fetch ─────────────────────────────────────────────────────────

/**
 * Build a minimal Response-like object whose headers.get() returns the
 * supplied map values (or null when absent).
 */
function makeResponse(headerMap) {
  return {
    headers: {
      get: (name) => headerMap[name] ?? null,
    },
  };
}

const GOOD_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; frame-ancestors 'none'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderDev(props = {}) {
  return render(<SecurityHeadersPage isProduction={false} {...props} />);
}

function renderProd() {
  return render(<SecurityHeadersPage isProduction={true} />);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #19 — Security Headers Diagnostic Page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Production gate ─────────────────────────────────────────────────────────

  describe('Production gate', () => {
    it('shows a non-production only message when isProduction=true', () => {
      renderProd();
      expect(
        screen.getByText(/only available in non-production/i)
      ).toBeInTheDocument();
    });

    it('does NOT render the audit table in production', () => {
      renderProd();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    });

    it('does NOT render the Run Audit button in production', () => {
      renderProd();
      expect(screen.queryByRole('button', { name: /run audit/i })).not.toBeInTheDocument();
    });
  });

  // ── Non-production UI ───────────────────────────────────────────────────────

  describe('Non-production UI', () => {
    it('renders the page heading', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(GOOD_HEADERS));
      renderDev();
      expect(
        screen.getByText('Security Headers Diagnostic')
      ).toBeInTheDocument();
    });

    it('renders the Run Audit button', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(GOOD_HEADERS));
      renderDev();
      expect(
        screen.getByRole('button', { name: /run audit/i })
      ).toBeInTheDocument();
    });

    it('runs audit automatically on mount', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(GOOD_HEADERS));
      renderDev();
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith('/', { method: 'HEAD' });
      });
    });
  });

  // ── Pass / Fail results ─────────────────────────────────────────────────────

  describe('All headers present and correct', () => {
    beforeEach(() => {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(GOOD_HEADERS));
    });

    it('renders a summary status after audit', async () => {
      renderDev();
      await waitFor(() => {
        expect(
          screen.getByRole('status')
        ).toBeInTheDocument();
      });
    });

    it('shows all-pass summary when every header is correct', async () => {
      renderDev();
      await waitFor(() => {
        expect(
          screen.getByText(/all required security headers are present/i)
        ).toBeInTheDocument();
      });
    });

    it('renders an audit results table', async () => {
      renderDev();
      await waitFor(() => {
        expect(
          screen.getByRole('table', { name: /security header audit results/i })
        ).toBeInTheDocument();
      });
    });

    it('shows Pass for all 4 headers', async () => {
      renderDev();
      await waitFor(() => {
        const passes = screen.getAllByText(/✓ Pass/i);
        expect(passes.length).toBe(4);
      });
    });
  });

  describe('Missing header', () => {
    it('reports a failing status when CSP is absent', async () => {
      const headers = { ...GOOD_HEADERS };
      delete headers['Content-Security-Policy'];
      global.fetch = jest.fn().mockResolvedValue(makeResponse(headers));

      renderDev();
      await waitFor(() => {
        expect(screen.getByText(/1 header check\(s\) failed/i)).toBeInTheDocument();
      });
    });

    it('marks CSP row as Fail when header is absent', async () => {
      const headers = { ...GOOD_HEADERS };
      delete headers['Content-Security-Policy'];
      global.fetch = jest.fn().mockResolvedValue(makeResponse(headers));

      renderDev();
      await waitFor(() => {
        expect(screen.getAllByText(/✗ Fail/i).length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('Wrong header value', () => {
    it('marks X-Frame-Options as Fail when value is SAMEORIGIN', async () => {
      const headers = { ...GOOD_HEADERS, 'X-Frame-Options': 'SAMEORIGIN' };
      global.fetch = jest.fn().mockResolvedValue(makeResponse(headers));

      renderDev();
      await waitFor(() => {
        expect(screen.getAllByText(/✗ Fail/i).length).toBeGreaterThanOrEqual(1);
      });
    });

    it('marks X-Content-Type-Options as Fail when value is wrong', async () => {
      const headers = { ...GOOD_HEADERS, 'X-Content-Type-Options': 'sniff' };
      global.fetch = jest.fn().mockResolvedValue(makeResponse(headers));

      renderDev();
      await waitFor(() => {
        expect(screen.getAllByText(/✗ Fail/i).length).toBeGreaterThanOrEqual(1);
      });
    });

    it('marks Referrer-Policy as Fail when value is wrong', async () => {
      const headers = { ...GOOD_HEADERS, 'Referrer-Policy': 'no-referrer' };
      global.fetch = jest.fn().mockResolvedValue(makeResponse(headers));

      renderDev();
      await waitFor(() => {
        expect(screen.getAllByText(/✗ Fail/i).length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe('CSP directive validation', () => {
    it('fails CSP when default-src is missing', async () => {
      const badCsp = "script-src 'self'; frame-ancestors 'none'; object-src 'none'";
      global.fetch = jest.fn().mockResolvedValue(
        makeResponse({ ...GOOD_HEADERS, 'Content-Security-Policy': badCsp })
      );

      renderDev();
      await waitFor(() => {
        expect(screen.getByText(/missing directives/i)).toBeInTheDocument();
      });
    });

    it('passes CSP when all required directives are present', async () => {
      global.fetch = jest.fn().mockResolvedValue(makeResponse(GOOD_HEADERS));

      renderDev();
      await waitFor(() => {
        expect(
          screen.getByText(/all required directives found/i)
        ).toBeInTheDocument();
      });
    });

    it("shows a note when 'unsafe-eval' appears in script-src (dev only)", async () => {
      const devCsp = GOOD_HEADERS['Content-Security-Policy'] + "; script-src 'self' 'unsafe-eval'";
      global.fetch = jest.fn().mockResolvedValue(
        makeResponse({ ...GOOD_HEADERS, 'Content-Security-Policy': devCsp })
      );

      renderDev();
      await waitFor(() => {
        expect(screen.getByText(/unsafe-eval/i)).toBeInTheDocument();
      });
    });
  });

  // ── Fetch error handling ────────────────────────────────────────────────────

  describe('Fetch error handling', () => {
    it('shows an error alert when fetch throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

      renderDev();
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
    });

    it('displays the error message in the alert', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

      renderDev();
      await waitFor(() => {
        expect(screen.getByText(/network failure/i)).toBeInTheDocument();
      });
    });
  });

  // ── CI policy validation (validates next.config.js header definition) ───────

  describe('CI: next.config.js policy validation', () => {
    let headers;
    let cspValue;

    beforeAll(async () => {
      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      jest.resetModules();
      const nextConfig = require('../frontend/next.config.js');
      const allHeaders = await nextConfig.headers();
      process.env.NODE_ENV = prevEnv;
      jest.resetModules();

      const entry = allHeaders.find((h) => h.source === '/(.*)');
      headers = entry ? entry.headers : [];
      const cspEntry = headers.find((h) => h.key === 'Content-Security-Policy');
      cspValue = cspEntry ? cspEntry.value : '';
    });

    it('next.config.js defines a Content-Security-Policy header', () => {
      expect(cspValue).toBeTruthy();
    });

    it('CSP contains default-src directive', () => {
      expect(cspValue).toMatch(/default-src/i);
    });

    it('CSP contains script-src directive', () => {
      expect(cspValue).toMatch(/script-src/i);
    });

    it("CSP contains frame-ancestors 'none'", () => {
      expect(cspValue).toMatch(/frame-ancestors\s+'none'/i);
    });

    it("CSP contains object-src 'none'", () => {
      expect(cspValue).toMatch(/object-src\s+'none'/i);
    });

    it('next.config.js defines X-Frame-Options: DENY', () => {
      const xfo = headers.find((h) => h.key === 'X-Frame-Options');
      expect(xfo).toBeDefined();
      expect(xfo.value).toBe('DENY');
    });

    it('next.config.js defines X-Content-Type-Options: nosniff', () => {
      const xcto = headers.find((h) => h.key === 'X-Content-Type-Options');
      expect(xcto).toBeDefined();
      expect(xcto.value).toBe('nosniff');
    });

    it('next.config.js defines Referrer-Policy: strict-origin-when-cross-origin', () => {
      const rp = headers.find((h) => h.key === 'Referrer-Policy');
      expect(rp).toBeDefined();
      expect(rp.value).toBe('strict-origin-when-cross-origin');
    });
  });
});
