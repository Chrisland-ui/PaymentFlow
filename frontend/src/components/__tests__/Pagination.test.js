/**
 * Tests for the shared Pagination component — Issue #23.
 *
 * Covers:
 *   - First/Previous/Next/Last disabled states at boundaries
 *   - Correct range announcement text
 *   - Page size selector renders and fires callback
 *   - onPageChange callbacks fire with correct values
 *   - All controls are disabled when loading=true
 *   - aria-live region is present for screen-reader announcements
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import i18n from "../../i18n";
import Pagination from "../Pagination";

function renderPagination(props) {
  return render(
    <I18nextProvider i18n={i18n}>
      <Pagination {...props} />
    </I18nextProvider>
  );
}

const BASE = {
  page: 1,
  pages: 5,
  total: 100,
  pageSize: 20,
  onPageChange: jest.fn(),
};

beforeEach(() => jest.clearAllMocks());

describe("Pagination — boundary disabled states", () => {
  it("disables First and Previous on page 1", () => {
    renderPagination({ ...BASE, page: 1 });
    expect(screen.getByLabelText(/first page/i)).toBeDisabled();
    expect(screen.getByLabelText(/previous page/i)).toBeDisabled();
  });

  it("enables Next and Last on page 1 when more pages exist", () => {
    renderPagination({ ...BASE, page: 1 });
    expect(screen.getByLabelText(/next page/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/last page/i)).not.toBeDisabled();
  });

  it("disables Next and Last on the last page", () => {
    renderPagination({ ...BASE, page: 5, pages: 5 });
    expect(screen.getByLabelText(/next page/i)).toBeDisabled();
    expect(screen.getByLabelText(/last page/i)).toBeDisabled();
  });

  it("enables First and Previous on the last page", () => {
    renderPagination({ ...BASE, page: 5, pages: 5 });
    expect(screen.getByLabelText(/first page/i)).not.toBeDisabled();
    expect(screen.getByLabelText(/previous page/i)).not.toBeDisabled();
  });

  it("disables all nav buttons when loading=true", () => {
    renderPagination({ ...BASE, page: 3, loading: true });
    expect(screen.getByLabelText(/first page/i)).toBeDisabled();
    expect(screen.getByLabelText(/previous page/i)).toBeDisabled();
    expect(screen.getByLabelText(/next page/i)).toBeDisabled();
    expect(screen.getByLabelText(/last page/i)).toBeDisabled();
  });
});

describe("Pagination — page change callbacks", () => {
  it("calls onPageChange(1) when First is clicked", () => {
    const onPageChange = jest.fn();
    renderPagination({ ...BASE, page: 3, onPageChange });
    fireEvent.click(screen.getByLabelText(/first page/i));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("calls onPageChange(page-1) when Previous is clicked", () => {
    const onPageChange = jest.fn();
    renderPagination({ ...BASE, page: 3, onPageChange });
    fireEvent.click(screen.getByLabelText(/previous page/i));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("calls onPageChange(page+1) when Next is clicked", () => {
    const onPageChange = jest.fn();
    renderPagination({ ...BASE, page: 3, onPageChange });
    fireEvent.click(screen.getByLabelText(/next page/i));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it("calls onPageChange(pages) when Last is clicked", () => {
    const onPageChange = jest.fn();
    renderPagination({ ...BASE, page: 3, onPageChange });
    fireEvent.click(screen.getByLabelText(/last page/i));
    expect(onPageChange).toHaveBeenCalledWith(5);
  });

  it("does not call onPageChange when already on first page and Previous clicked", () => {
    const onPageChange = jest.fn();
    renderPagination({ ...BASE, page: 1, onPageChange });
    // button is disabled so click has no effect
    fireEvent.click(screen.getByLabelText(/previous page/i));
    expect(onPageChange).not.toHaveBeenCalled();
  });
});

describe("Pagination — range announcement", () => {
  it("renders the result range for screen readers via aria-live", () => {
    renderPagination({ ...BASE, page: 2, pageSize: 20, total: 100 });
    // Page 2 of 20-per-page: items 21–40 of 100
    const live = document.querySelector("[aria-live]");
    expect(live).not.toBeNull();
    expect(live.textContent).toMatch(/21/);
    expect(live.textContent).toMatch(/40/);
    expect(live.textContent).toMatch(/100/);
  });

  it("shows loading text when loading=true", () => {
    renderPagination({ ...BASE, loading: true });
    const live = document.querySelector("[aria-live]");
    expect(live.textContent.toLowerCase()).toMatch(/loading/);
  });

  it("shows 'No results' when total is 0", () => {
    renderPagination({ ...BASE, total: 0, pages: 0 });
    const live = document.querySelector("[aria-live]");
    expect(live.textContent.toLowerCase()).toMatch(/no results/);
  });
});

describe("Pagination — page size selector", () => {
  it("renders page size options when onPageSizeChange is provided", () => {
    const onPageSizeChange = jest.fn();
    renderPagination({ ...BASE, onPageSizeChange, pageSizeOptions: [10, 20, 50] });
    expect(screen.getByLabelText(/rows per page/i)).toBeInTheDocument();
  });

  it("calls onPageSizeChange with the new value on change", () => {
    const onPageSizeChange = jest.fn();
    renderPagination({ ...BASE, onPageSizeChange, pageSizeOptions: [10, 20, 50] });
    fireEvent.change(screen.getByLabelText(/rows per page/i), { target: { value: "50" } });
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("does not render page size selector when onPageSizeChange is omitted", () => {
    renderPagination({ ...BASE });
    expect(screen.queryByLabelText(/rows per page/i)).toBeNull();
  });
});

describe("Pagination — accessibility", () => {
  it("renders a <nav> with an accessible label", () => {
    renderPagination({ ...BASE });
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeInTheDocument();
  });

  it("marks the current page indicator with aria-current='page'", () => {
    renderPagination({ ...BASE, page: 3 });
    const current = document.querySelector("[aria-current='page']");
    expect(current).not.toBeNull();
    expect(current.textContent).toMatch(/3/);
  });
});
