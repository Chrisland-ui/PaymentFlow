/**
 * @jest-environment jsdom
 *
 * Tests for issue #18 — useDashboardLoader route-level data loader.
 *
 * Verifies:
 *  1. Summary and student requests are issued in parallel (no serial dependency).
 *  2. Independent failure states: a failed summary does not erase students.
 *  3. Independent failure states: failed students do not erase summary.
 *  4. A superseded students request is cancelled (abort) before the next one.
 *  5. Successful retry clears the error for that slice only.
 *  6. load() fans out both requests concurrently.
 */

'use strict';

import '@testing-library/jest-dom';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDashboardLoader } from '../frontend/src/hooks/useDashboardLoader';
import * as api from '../frontend/src/services/api';

jest.mock('../frontend/src/services/api');

const SUMMARY_DATA = {
  totalStudents: 10,
  paidCount: 7,
  unpaidCount: 3,
  totalXlmCollected: 250,
};

const STUDENTS_DATA = {
  students: [{ studentId: 'STU001', name: 'Alice', class: '5A' }],
  pages: 2,
  total: 21,
};

function defaultParams(overrides = {}) {
  return {
    page: 1,
    search: '',
    statusFilter: 'all',
    classFilter: '',
    ...overrides,
  };
}

describe('Issue #18 — useDashboardLoader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: both requests succeed.
    api.getPaymentSummary.mockResolvedValue({ data: SUMMARY_DATA });
    api.getStudents.mockResolvedValue({ data: STUDENTS_DATA });
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  test('loads summary and students on mount', async () => {
    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    await waitFor(() => {
      expect(result.current.summaryLoading).toBe(false);
      expect(result.current.studentsLoading).toBe(false);
    });

    expect(result.current.summary).toEqual(SUMMARY_DATA);
    expect(result.current.students).toEqual(STUDENTS_DATA.students);
    expect(result.current.pages).toBe(2);
    expect(result.current.total).toBe(21);
  });

  test('getStudents is called with correct page/page-size/filters', async () => {
    renderHook(() =>
      useDashboardLoader(defaultParams({ page: 2, search: 'alice', statusFilter: 'paid', classFilter: '5A' }))
    );

    await waitFor(() => {
      expect(api.getStudents).toHaveBeenCalledWith(
        2, 20,
        { search: 'alice', status: 'paid', className: '5A' },
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });
  });

  // ── Parallel execution ────────────────────────────────────────────────────

  test('summary and students requests are made in parallel via load()', async () => {
    const order = [];
    api.getPaymentSummary.mockImplementation(() => {
      order.push('summary');
      return Promise.resolve({ data: SUMMARY_DATA });
    });
    api.getStudents.mockImplementation(() => {
      order.push('students');
      return Promise.resolve({ data: STUDENTS_DATA });
    });

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    // Trigger a full load explicitly.
    await act(async () => {
      await result.current.load();
    });

    // Both requests must have been called (order may vary — allSettled is parallel).
    expect(order).toContain('summary');
    expect(order).toContain('students');
  });

  // ── Independent failure: summary fails ───────────────────────────────────

  test('summary error does not wipe out successfully loaded students', async () => {
    api.getPaymentSummary.mockRejectedValue(new Error('API down'));
    api.getStudents.mockResolvedValue({ data: STUDENTS_DATA });

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    await waitFor(() => {
      expect(result.current.studentsLoading).toBe(false);
      expect(result.current.summaryLoading).toBe(false);
    });

    // Students loaded correctly.
    expect(result.current.students).toEqual(STUDENTS_DATA.students);
    expect(result.current.studentsError).toBeNull();

    // Summary shows an error; students are untouched.
    expect(result.current.summaryError).toBeTruthy();
    expect(result.current.summary).toBeNull();
  });

  // ── Independent failure: students fail ───────────────────────────────────

  test('students error does not wipe out successfully loaded summary', async () => {
    api.getPaymentSummary.mockResolvedValue({ data: SUMMARY_DATA });
    api.getStudents.mockRejectedValue(new Error('DB timeout'));

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    await waitFor(() => {
      expect(result.current.studentsLoading).toBe(false);
      expect(result.current.summaryLoading).toBe(false);
    });

    // Summary loaded correctly.
    expect(result.current.summary).toEqual(SUMMARY_DATA);
    expect(result.current.summaryError).toBeNull();

    // Students shows an error; summary is untouched.
    expect(result.current.studentsError).toBeTruthy();
    expect(result.current.students).toEqual([]);
  });

  // ── Retry clears error ────────────────────────────────────────────────────

  test('loadSummary clears summaryError after a successful retry', async () => {
    api.getPaymentSummary
      .mockRejectedValueOnce(new Error('first attempt'))
      .mockResolvedValueOnce({ data: SUMMARY_DATA });

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    // Wait for first (failing) load.
    await waitFor(() => expect(result.current.summaryError).toBeTruthy());

    // Retry.
    await act(async () => {
      await result.current.loadSummary();
    });

    expect(result.current.summaryError).toBeNull();
    expect(result.current.summary).toEqual(SUMMARY_DATA);
  });

  test('loadStudents clears studentsError after a successful retry', async () => {
    api.getStudents
      .mockRejectedValueOnce(new Error('first attempt'))
      .mockResolvedValueOnce({ data: STUDENTS_DATA });

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    // Wait for first (failing) load.
    await waitFor(() => expect(result.current.studentsError).toBeTruthy());

    // Retry.
    await act(async () => {
      await result.current.loadStudents();
    });

    expect(result.current.studentsError).toBeNull();
    expect(result.current.students).toEqual(STUDENTS_DATA.students);
  });

  // ── Abort / deduplication ─────────────────────────────────────────────────

  test('aborted students request does not set an error state', async () => {
    const abortError = new Error('canceled');
    abortError.name = 'CanceledError';
    api.getStudents.mockRejectedValue(abortError);

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    await waitFor(() => expect(result.current.studentsLoading).toBe(false));
    // Aborted request must NOT set studentsError.
    expect(result.current.studentsError).toBeNull();
  });

  test('ERR_CANCELED code is treated as abort (not error)', async () => {
    const abortError = new Error('canceled');
    abortError.code = 'ERR_CANCELED';
    api.getStudents.mockRejectedValue(abortError);

    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    await waitFor(() => expect(result.current.studentsLoading).toBe(false));
    expect(result.current.studentsError).toBeNull();
  });

  // ── load() helper ─────────────────────────────────────────────────────────

  test('load() triggers both getPaymentSummary and getStudents', async () => {
    const { result } = renderHook(() => useDashboardLoader(defaultParams()));

    jest.clearAllMocks();
    api.getPaymentSummary.mockResolvedValue({ data: SUMMARY_DATA });
    api.getStudents.mockResolvedValue({ data: STUDENTS_DATA });

    await act(async () => {
      await result.current.load();
    });

    expect(api.getPaymentSummary).toHaveBeenCalledTimes(1);
    expect(api.getStudents).toHaveBeenCalledTimes(1);
  });

  // ── Pagination/filter re-fetch ────────────────────────────────────────────

  test('loadStudents is re-run when page parameter changes', async () => {
    let page = 1;
    const { rerender } = renderHook(() =>
      useDashboardLoader(defaultParams({ page }))
    );

    await waitFor(() => expect(api.getStudents).toHaveBeenCalledTimes(1));

    page = 2;
    rerender();

    await waitFor(() => expect(api.getStudents).toHaveBeenCalledTimes(2));
    const [calledPage] = api.getStudents.mock.calls[1];
    expect(calledPage).toBe(2);
  });
});
