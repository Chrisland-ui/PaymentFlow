/**
 * Tests for useNetworkStatus — Issue #21.
 *
 * Covers:
 *   - Initialises as online when navigator.onLine is true
 *   - Initialises as offline when navigator.onLine is false
 *   - Goes offline when the 'offline' event fires
 *   - Goes online when the 'online' event fires after being offline
 *   - wasOffline becomes true after going offline
 *   - wasOffline stays true during the linger window after reconnecting
 *   - wasOffline resets to false after the linger timer expires
 *   - Cleanup removes event listeners on unmount
 */

import { renderHook, act } from '@testing-library/react';
import { useNetworkStatus } from '../useNetworkStatus';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fireWindowEvent(name) {
  act(() => {
    window.dispatchEvent(new Event(name));
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useNetworkStatus — initial state', () => {
  it('reports isOnline:true when navigator.onLine is true', () => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);
    expect(result.current.wasOffline).toBe(false);
  });

  it('reports isOnline:false when navigator.onLine is false', () => {
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(false);
  });
});

describe('useNetworkStatus — offline transition', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
  });

  it('sets isOnline:false when the offline event fires', () => {
    const { result } = renderHook(() => useNetworkStatus());
    expect(result.current.isOnline).toBe(true);
    fireWindowEvent('offline');
    expect(result.current.isOnline).toBe(false);
  });

  it('sets wasOffline:true when the offline event fires', () => {
    const { result } = renderHook(() => useNetworkStatus());
    fireWindowEvent('offline');
    expect(result.current.wasOffline).toBe(true);
  });
});

describe('useNetworkStatus — online transition after being offline', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('sets isOnline:true when the online event fires', () => {
    const { result } = renderHook(() => useNetworkStatus());
    fireWindowEvent('offline');
    expect(result.current.isOnline).toBe(false);
    fireWindowEvent('online');
    expect(result.current.isOnline).toBe(true);
  });

  it('wasOffline stays true immediately after coming back online (linger window)', () => {
    const { result } = renderHook(() => useNetworkStatus());
    fireWindowEvent('offline');
    fireWindowEvent('online');
    // Linger window: wasOffline is still true right after reconnect
    expect(result.current.wasOffline).toBe(true);
    expect(result.current.isOnline).toBe(true);
  });

  it('wasOffline resets to false after the linger timer expires', () => {
    const { result } = renderHook(() => useNetworkStatus());
    fireWindowEvent('offline');
    fireWindowEvent('online');
    expect(result.current.wasOffline).toBe(true);
    // Advance past the 3 s linger window
    act(() => { jest.advanceTimersByTime(4000); });
    expect(result.current.wasOffline).toBe(false);
  });
});

describe('useNetworkStatus — cleanup', () => {
  it('removes event listeners when the hook unmounts', () => {
    const addSpy    = jest.spyOn(window, 'addEventListener');
    const removeSpy = jest.spyOn(window, 'removeEventListener');

    Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
    const { unmount } = renderHook(() => useNetworkStatus());

    const onlineListeners  = addSpy.mock.calls.filter(([e]) => e === 'online');
    const offlineListeners = addSpy.mock.calls.filter(([e]) => e === 'offline');
    expect(onlineListeners.length).toBeGreaterThanOrEqual(1);
    expect(offlineListeners.length).toBeGreaterThanOrEqual(1);

    unmount();

    const removedOnline  = removeSpy.mock.calls.filter(([e]) => e === 'online');
    const removedOffline = removeSpy.mock.calls.filter(([e]) => e === 'offline');
    expect(removedOnline.length).toBeGreaterThanOrEqual(1);
    expect(removedOffline.length).toBeGreaterThanOrEqual(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
