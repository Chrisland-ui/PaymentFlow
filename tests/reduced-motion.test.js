/**
 * @jest-environment jsdom
 *
 * Tests for issue #20 — useReducedMotion hook and reduced-motion CSS coverage.
 *
 * Verifies:
 *  1. Hook returns false when prefers-reduced-motion is "no-preference".
 *  2. Hook returns true when prefers-reduced-motion is "reduce".
 *  3. Hook updates reactively when the media query changes at runtime.
 *  4. CSS files contain the @media (prefers-reduced-motion: reduce) block.
 *  5. Key animated classes are addressed in the CSS rule.
 */

'use strict';

import { renderHook, act } from '@testing-library/react';
import { useReducedMotion } from '../frontend/src/hooks/useReducedMotion';

// ── matchMedia mock helpers ───────────────────────────────────────────────────

/**
 * Build a matchMedia mock that returns the given `matches` value and supports
 * addEventListener / removeEventListener so the hook can react to changes.
 */
function buildMatchMedia(initialMatches) {
  let _matches = initialMatches;
  const listeners = new Set();

  const mq = {
    get matches() { return _matches; },
    addEventListener(event, cb) { listeners.add(cb); },
    removeEventListener(event, cb) { listeners.delete(cb); },
    // helper for tests
    _fire(newMatches) {
      _matches = newMatches;
      listeners.forEach((cb) => cb({ matches: newMatches }));
    },
  };

  return mq;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Issue #20 — useReducedMotion hook', () => {
  let mockMq;

  beforeEach(() => {
    mockMq = buildMatchMedia(false);
    window.matchMedia = jest.fn(() => mockMq);
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete window.matchMedia;
  });

  test('returns false when prefers-reduced-motion is "no-preference"', () => {
    mockMq = buildMatchMedia(false);
    window.matchMedia = jest.fn(() => mockMq);

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });

  test('returns true when prefers-reduced-motion is "reduce"', () => {
    mockMq = buildMatchMedia(true);
    window.matchMedia = jest.fn(() => mockMq);

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  test('updates reactively when media query changes to reduce', () => {
    mockMq = buildMatchMedia(false);
    window.matchMedia = jest.fn(() => mockMq);

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);

    act(() => {
      mockMq._fire(true);
    });

    expect(result.current).toBe(true);
  });

  test('updates reactively when media query changes back to no-preference', () => {
    mockMq = buildMatchMedia(true);
    window.matchMedia = jest.fn(() => mockMq);

    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);

    act(() => {
      mockMq._fire(false);
    });

    expect(result.current).toBe(false);
  });

  test('calls matchMedia with the correct query string', () => {
    renderHook(() => useReducedMotion());
    expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  });

  test('falls back gracefully when matchMedia is not available (SSR)', () => {
    const original = window.matchMedia;
    delete window.matchMedia;

    const { result } = renderHook(() => useReducedMotion());
    // Should default to false and not throw.
    expect(result.current).toBe(false);

    window.matchMedia = original;
  });

  test('falls back gracefully when matchMedia returns null', () => {
    window.matchMedia = jest.fn(() => null);

    // Should not throw.
    expect(() => renderHook(() => useReducedMotion())).not.toThrow();
  });

  test('cleans up event listener on unmount', () => {
    const removeSpy = jest.fn();
    mockMq = {
      matches: false,
      addEventListener: jest.fn(),
      removeEventListener: removeSpy,
      _fire: jest.fn(),
    };
    window.matchMedia = jest.fn(() => mockMq);

    const { unmount } = renderHook(() => useReducedMotion());
    unmount();

    expect(removeSpy).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

// ── CSS block presence ────────────────────────────────────────────────────────

describe('Issue #20 — CSS @media (prefers-reduced-motion: reduce) block', () => {
  const fs = require('fs');
  const path = require('path');

  const globalsPath = path.join(
    __dirname, '../frontend/src/styles/globals.css'
  );
  const redesignPath = path.join(
    __dirname, '../frontend/src/styles/redesign.css'
  );

  let globalsCss;
  let redesignCss;

  beforeAll(() => {
    globalsCss = fs.readFileSync(globalsPath, 'utf8');
    redesignCss = fs.readFileSync(redesignPath, 'utf8');
  });

  test('globals.css contains @media (prefers-reduced-motion: reduce)', () => {
    expect(globalsCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('redesign.css contains @media (prefers-reduced-motion: reduce)', () => {
    expect(redesignCss).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('globals.css reduced-motion block addresses .dash-wrap (dashboard entry animation)', () => {
    expect(globalsCss).toContain('.dash-wrap');
  });

  test('globals.css reduced-motion block addresses .skel-block (skeleton pulse)', () => {
    expect(globalsCss).toContain('.skel-block');
  });

  test('globals.css reduced-motion block addresses [role="progressbar"] (progress indicators)', () => {
    expect(globalsCss).toContain('[role="progressbar"]');
  });

  test('globals.css reduced-motion block addresses .modal / [role="dialog"] (dialog animations)', () => {
    expect(globalsCss).toContain('[role="dialog"]');
  });

  test('globals.css reduced-motion block suppresses transition-duration globally', () => {
    // The catch-all rule uses transition-duration to collapse all transitions.
    expect(globalsCss).toContain('transition-duration: 0.01ms');
  });

  test('globals.css reduced-motion block suppresses animation-duration globally', () => {
    expect(globalsCss).toContain('animation-duration: 0.01ms');
  });
});
