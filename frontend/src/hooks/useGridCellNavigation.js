import { useEffect, useId, useRef } from "react";

const CELL_SELECTOR = "[data-grid-cell]";
const TEXT_INPUT_SELECTOR = "input, select, textarea, [contenteditable='true']";

export default function useGridCellNavigation() {
  const ref = useRef(null);
  const activePositionRef = useRef({ rowIndex: 0, colIndex: 0 });
  const idPrefix = useId();

  useEffect(() => {
    const grid = ref.current;
    if (!grid) return;

    const rows = Array.from(grid.querySelectorAll('[role="row"]'));
    rows.forEach((row, rowIndex) => {
      Array.from(row.querySelectorAll(CELL_SELECTOR)).forEach((cell, colIndex) => {
        cell.id = `${idPrefix}-row-${rowIndex}-cell-${colIndex}`;
      });
    });

    const cells = Array.from(grid.querySelectorAll(CELL_SELECTOR));
    const activeId = grid.getAttribute("aria-activedescendant");
    if (!cells.some((cell) => cell.id === activeId) && cells[0]) {
      const rowsWithCells = rows.map((row) => Array.from(row.querySelectorAll(CELL_SELECTOR))).filter((row) => row.length);
      const rowIndex = Math.min(activePositionRef.current.rowIndex, rowsWithCells.length - 1);
      const row = rowsWithCells[rowIndex];
      const cell = row?.[Math.min(activePositionRef.current.colIndex, row.length - 1)];
      if (cell) grid.setAttribute("aria-activedescendant", cell.id);
    }
  });

  function rememberPosition(grid, cell) {
    const rows = Array.from(grid.querySelectorAll('[role="row"]'))
      .map((row) => Array.from(row.querySelectorAll(CELL_SELECTOR)))
      .filter((row) => row.length);
    const rowIndex = rows.findIndex((row) => row.includes(cell));
    activePositionRef.current = {
      rowIndex: Math.max(0, rowIndex),
      colIndex: Math.max(0, rows[rowIndex]?.indexOf(cell) ?? 0),
    };
  }

  function handleFocusCapture(event) {
    const cell = event.target.closest(CELL_SELECTOR);
    if (cell && ref.current?.contains(cell)) {
      rememberPosition(ref.current, cell);
      ref.current.setAttribute("aria-activedescendant", cell.id);
    }
  }

  function handleClickCapture(event) {
    const cell = event.target.closest(CELL_SELECTOR);
    if (cell && ref.current?.contains(cell) && !event.target.closest("button, a")) {
      rememberPosition(ref.current, cell);
      ref.current.setAttribute("aria-activedescendant", cell.id);
    }
  }

  function handleKeyDown(event) {
    const grid = ref.current;
    if (!grid || (event.target !== grid && event.target.closest(TEXT_INPUT_SELECTOR))) return;

    const rows = Array.from(grid.querySelectorAll('[role="row"]'))
      .map((row) => Array.from(row.querySelectorAll(CELL_SELECTOR)));
    const activeId = grid.getAttribute("aria-activedescendant");
    const rowIndex = rows.findIndex((cells) => cells.some((cell) => cell.id === activeId));
    const currentRow = rows[rowIndex] || rows[0];
    const colIndex = currentRow?.findIndex((cell) => cell.id === activeId) ?? 0;
    let target;

    if (event.ctrlKey && event.key === "Home") {
      target = rows[0]?.[0];
    } else if (event.ctrlKey && event.key === "End") {
      target = rows[rows.length - 1]?.at(-1);
    } else if (event.key === "Home") {
      target = currentRow?.[0];
    } else if (event.key === "End") {
      target = currentRow?.at(-1);
    } else if (event.key === "ArrowLeft") {
      target = currentRow?.[Math.max(0, colIndex - 1)];
    } else if (event.key === "ArrowRight") {
      target = currentRow?.[Math.min(currentRow.length - 1, colIndex + 1)];
    } else if (event.key === "ArrowUp") {
      const previousRow = rows[Math.max(0, rowIndex - 1)];
      target = previousRow?.[Math.min(colIndex, previousRow.length - 1)];
    } else if (event.key === "ArrowDown") {
      const nextRow = rows[Math.min(rows.length - 1, rowIndex + 1)];
      target = nextRow?.[Math.min(colIndex, nextRow.length - 1)];
    } else if (event.key === "Enter" || event.key === " ") {
      if (event.target.matches("button, a")) return;
      const activeCell = Array.from(grid.querySelectorAll(CELL_SELECTOR))
        .find((cell) => cell.id === activeId);
      const row = activeCell?.closest('[role="row"]');
      const action = row?.classList.contains("row-clickable")
        ? row
        : activeCell?.querySelector("button, a");
      if (action) {
        event.preventDefault();
        action.click();
      }
    }

    if (target) {
      event.preventDefault();
      rememberPosition(grid, target);
      grid.setAttribute("aria-activedescendant", target.id);
      grid.focus();
    }
  }

  return {
    ref,
    tabIndex: 0,
    onFocusCapture: handleFocusCapture,
    onClickCapture: handleClickCapture,
    onKeyDown: handleKeyDown,
  };
}
