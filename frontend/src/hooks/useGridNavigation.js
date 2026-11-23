/**
 * useGridNavigation — Issue #10
 *
 * Implements roving-tabindex keyboard navigation for data-grid tables.
 *
 * Semantics
 * ---------
 *   ↑ / ↓        Move focus to the previous / next body row.
 *   Home         Move focus to the first body row.
 *   End          Move focus to the last body row.
 *   Enter / Space  Activate the focused row (calls onActivate).
 *   Tab           Tab key leaves the grid naturally; the grid container
 *                 itself carries tabIndex=0 so the user can re-enter it.
 *
 * Usage
 * -----
 *   const { focusedIndex, tbodyRef, liveAnnouncement, getRowProps } =
 *     useGridNavigation({ rowCount, onActivate, getAnnouncement });
 *
 *   <div role="grid" aria-rowcount={rowCount} …>
 *     <table>
 *       <tbody ref={tbodyRef}>
 *         {rows.map((row, i) => (
 *           <tr {...getRowProps(i, row)} key={row.id}>…</tr>
 *         ))}
 *       </tbody>
 *     </table>
 *   </div>
 *   <div aria-live="polite" aria-atomic="true" className="sr-only">
 *     {liveAnnouncement}
 *   </div>
 *
 * @param {object}   options
 * @param {number}   options.rowCount        Total number of navigable rows.
 * @param {function} [options.onActivate]    Called with (index) when the row is activated.
 * @param {function} [options.getAnnouncement] Called with (index) → string for the live region.
 * @param {boolean}  [options.disabled]      Set true to skip keyboard wiring (e.g. empty / loading).
 *
 * @returns {{
 *   focusedIndex: number,
 *   tbodyRef: React.RefObject,
 *   liveAnnouncement: string,
 *   getRowProps: (index: number, data?: any) => object,
 * }}
 */
import { useState, useRef, useCallback } from "react";

export function useGridNavigation({
  rowCount,
  onActivate,
  getAnnouncement,
  disabled = false,
}) {
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [liveAnnouncement, setLiveAnnouncement] = useState("");
  const tbodyRef = useRef(null);

  /** Move focus to the row at `index` and update the live region. */
  const moveFocus = useCallback(
    (index) => {
      if (disabled || rowCount === 0) return;
      const clamped = Math.max(0, Math.min(index, rowCount - 1));
      setFocusedIndex(clamped);

      // Imperatively move browser focus to the <tr> element.
      const tbody = tbodyRef.current;
      if (tbody) {
        const rows = tbody.querySelectorAll("tr[data-grid-row]");
        if (rows[clamped]) {
          rows[clamped].focus({ preventScroll: false });
        }
      }

      // Announce the focused row to screen-reader users.
      if (typeof getAnnouncement === "function") {
        setLiveAnnouncement(getAnnouncement(clamped));
      }
    },
    [disabled, rowCount, getAnnouncement]
  );

  /**
   * Keyboard handler — attach to the grid container (or individual rows).
   * We attach it on the <tbody> level so event delegation keeps things simple.
   */
  const handleKeyDown = useCallback(
    (e) => {
      if (disabled) return;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveFocus(focusedIndex < 0 ? 0 : focusedIndex + 1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(focusedIndex <= 0 ? 0 : focusedIndex - 1);
          break;
        case "Home":
          e.preventDefault();
          moveFocus(0);
          break;
        case "End":
          e.preventDefault();
          moveFocus(rowCount - 1);
          break;
        case "Enter":
        case " ":
          if (focusedIndex >= 0 && typeof onActivate === "function") {
            e.preventDefault();
            onActivate(focusedIndex);
          }
          break;
        default:
          break;
      }
    },
    [disabled, focusedIndex, rowCount, moveFocus, onActivate]
  );

  /**
   * Returns props to spread on each <tr> element.
   *
   * @param {number} index    Zero-based row index within the visible rows.
   * @param {*}      [_data]  Reserved for future use (row data reference).
   */
  const getRowProps = useCallback(
    (index) => ({
      "data-grid-row": true,
      // Roving tabindex: only the focused row (or row 0 if none focused) is
      // reachable with Tab; all others are programmatically focusable only.
      tabIndex: focusedIndex < 0 ? (index === 0 ? 0 : -1) : focusedIndex === index ? 0 : -1,
      onFocus: () => {
        setFocusedIndex(index);
        if (typeof getAnnouncement === "function") {
          setLiveAnnouncement(getAnnouncement(index));
        }
      },
      "aria-rowindex": index + 2, // +2 because row 1 is the <thead> row
    }),
    [focusedIndex, getAnnouncement]
  );

  return {
    focusedIndex,
    tbodyRef,
    liveAnnouncement,
    handleKeyDown,
    getRowProps,
    moveFocus,
  };
}
