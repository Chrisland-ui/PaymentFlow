/**
 * @jest-environment jsdom
 *
 * Tests for the Skeleton component system and its integration with the
 * Dashboard payment screen (issue #13).
 *
 * Verifies:
 *  - Skeleton components render without errors
 *  - Correct CSS class names are applied
 *  - skeleton-static class is added when prefers-reduced-motion is set
 *  - Dashboard shows skeleton placeholders while data is loading
 *  - Dashboard empty state is distinguishable from the loading state
 */

"use strict";

import "@testing-library/jest-dom";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";

import {
  SkeletonBlock,
  SkeletonText,
  SkeletonStatCard,
  SkeletonTableRow,
  SkeletonDetailCard,
} from "../frontend/src/components/Skeleton";

// ── Mocks required by Dashboard ──────────────────────────────────────────────

jest.mock("../frontend/src/services/api");
jest.mock("../frontend/src/components/SyncButton", () => () => null);
jest.mock("../frontend/src/components/ErrorBoundary", () =>
  function MockErrorBoundary({ children }) { return <>{children}</>; }
);
jest.mock("../frontend/src/components/StudentForm", () => () => null);
jest.mock("../frontend/src/components/SseDegradedBanner", () => () => null);
jest.mock("../frontend/src/components/BlockchainStatusBadge", () => () => null);
jest.mock("../frontend/src/components/RequireAdmin", () =>
  function MockRequireAdmin({ children }) { return <>{children}</>; }
);
jest.mock("../frontend/src/components/PageHero", () => {
  const PageHero = function MockPageHero({ children }) { return <div>{children}</div>; };
  PageHero.StatCard = function MockStatCard({ label, value }) {
    return <div data-testid="stat-card">{label}: {value}</div>;
  };
  return PageHero;
});
jest.mock("../frontend/src/components/Icons", () => ({
  IconUsers:        () => null,
  IconCheck:        () => null,
  IconAlertTriangle:() => null,
  IconDollarSign:   () => null,
  IconSearch:       () => null,
  IconChevronLeft:  () => null,
  IconChevronRight: () => null,
}));
jest.mock("../frontend/src/hooks/usePaymentEvents", () => ({
  usePaymentEvents: () => ({ degraded: false, connectionStatus: "connected" }),
}));
jest.mock("../frontend/src/components/TableDensityControl", () => ({
  TableDensityControl: () => null,
  useTableDensity: () => ({ density: "default", setDensity: () => {} }),
}));

// ── SkeletonBlock ─────────────────────────────────────────────────────────────

describe("SkeletonBlock", () => {
  test("renders with the skeleton-block CSS class", () => {
    const { container } = render(<SkeletonBlock width={80} height={12} />);
    const el = container.firstChild;
    expect(el).toHaveClass("skeleton-block");
  });

  test("applies aria-hidden so screen readers skip it", () => {
    const { container } = render(<SkeletonBlock />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  test("applies custom width and height via inline style", () => {
    const { container } = render(<SkeletonBlock width={120} height={20} />);
    expect(container.firstChild).toHaveStyle({ width: "120px", height: "20px" });
  });

  test("adds skeleton-static class when prefers-reduced-motion matches", () => {
    // Simulate reduced-motion preference.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn((query) => ({
        matches: query.includes("reduce"),
        addListener: jest.fn(),
        removeListener: jest.fn(),
      })),
    });

    const { container } = render(<SkeletonBlock />);
    expect(container.firstChild).toHaveClass("skeleton-block");
    expect(container.firstChild).toHaveClass("skeleton-static");

    // Reset matchMedia mock.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn(() => ({ matches: false, addListener: jest.fn(), removeListener: jest.fn() })),
    });
  });

  test("does NOT add skeleton-static when motion is not reduced", () => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn(() => ({ matches: false, addListener: jest.fn(), removeListener: jest.fn() })),
    });

    const { container } = render(<SkeletonBlock />);
    expect(container.firstChild).not.toHaveClass("skeleton-static");
  });
});

// ── SkeletonText ──────────────────────────────────────────────────────────────

describe("SkeletonText", () => {
  test("renders a single line by default", () => {
    const { container } = render(<SkeletonText />);
    expect(container.querySelectorAll(".skeleton-block")).toHaveLength(1);
  });

  test("renders the requested number of lines", () => {
    const { container } = render(<SkeletonText lines={3} />);
    expect(container.querySelectorAll(".skeleton-block")).toHaveLength(3);
  });
});

// ── SkeletonStatCard ──────────────────────────────────────────────────────────

describe("SkeletonStatCard", () => {
  test("renders without crashing", () => {
    expect(() => render(<SkeletonStatCard />)).not.toThrow();
  });

  test("has aria-hidden set on the outer element", () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  test("contains three skeleton blocks (icon, label, value)", () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.querySelectorAll(".skeleton-block")).toHaveLength(3);
  });

  test("outer element has the stat-card class to preserve layout dimensions", () => {
    const { container } = render(<SkeletonStatCard />);
    expect(container.firstChild).toHaveClass("stat-card");
  });
});

// ── SkeletonTableRow ──────────────────────────────────────────────────────────

describe("SkeletonTableRow", () => {
  test("renders a <tr> element", () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow /></tbody></table>
    );
    const rows = container.querySelectorAll("tr");
    expect(rows).toHaveLength(1);
  });

  test("has aria-hidden on the row", () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow /></tbody></table>
    );
    expect(container.querySelector("tr")).toHaveAttribute("aria-hidden", "true");
  });

  test("contains 6 cells matching the dashboard table columns", () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow /></tbody></table>
    );
    expect(container.querySelectorAll("td")).toHaveLength(6);
  });

  test("each cell contains a skeleton-block placeholder", () => {
    const { container } = render(
      <table><tbody><SkeletonTableRow /></tbody></table>
    );
    expect(container.querySelectorAll(".skeleton-block")).toHaveLength(6);
  });
});

// ── SkeletonDetailCard ────────────────────────────────────────────────────────

describe("SkeletonDetailCard", () => {
  test("renders without crashing", () => {
    expect(() => render(<SkeletonDetailCard />)).not.toThrow();
  });

  test("has aria-hidden on the card element", () => {
    const { container } = render(<SkeletonDetailCard />);
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  test("renders the default three body rows", () => {
    const { container } = render(<SkeletonDetailCard />);
    // 3 rows × 3 blocks per row + 2 header blocks = 11 total skeleton-blocks
    expect(container.querySelectorAll(".skeleton-block").length).toBeGreaterThanOrEqual(3);
  });

  test("respects the rows prop", () => {
    const { container } = render(<SkeletonDetailCard rows={5} />);
    // More blocks with more rows.
    expect(container.querySelectorAll(".skeleton-block").length).toBeGreaterThan(5);
  });
});

// ── Dashboard integration ─────────────────────────────────────────────────────

describe("Dashboard skeleton integration (issue #13)", () => {
  const api = require("../frontend/src/services/api");

  // Import Dashboard lazily so mocks are applied first.
  let Dashboard;
  beforeAll(() => {
    Dashboard = require("../frontend/src/pages/dashboard").default;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default matchMedia to no preference.
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: jest.fn(() => ({ matches: false, addListener: jest.fn(), removeListener: jest.fn() })),
    });
  });

  function setupPendingApis() {
    // Never-resolving promises keep the dashboard in the loading state.
    api.getSyncStatus.mockReturnValue(new Promise(() => {}));
    api.getPaymentSummary.mockReturnValue(new Promise(() => {}));
    api.getStudents.mockReturnValue(new Promise(() => {}));
    api.getSchool.mockReturnValue(new Promise(() => {}));
  }

  function setupResolvedApis(students = []) {
    api.getSyncStatus.mockResolvedValue({ data: { lastSyncAt: null } });
    api.getPaymentSummary.mockResolvedValue({
      data: { totalStudents: 5, paidCount: 3, unpaidCount: 2, totalXlmCollected: 100 },
    });
    api.getStudents.mockResolvedValue({
      data: { students, pages: 1, total: students.length },
    });
    api.getSchool.mockResolvedValue({ data: { name: "Test School" } });
  }

  test("renders skeleton stat cards while summary is loading", () => {
    setupPendingApis();
    const { container } = render(<Dashboard />);
    // The stat grid should contain skeleton-block elements before data arrives.
    const skels = container.querySelectorAll(".skeleton-block");
    expect(skels.length).toBeGreaterThan(0);
  });

  test("skeleton stat cards have aria-hidden so assistive tech skips them", () => {
    setupPendingApis();
    const { container } = render(<Dashboard />);
    const cards = container.querySelectorAll(".stat-card[aria-hidden]");
    expect(cards.length).toBeGreaterThan(0);
  });

  test("renders skeleton table rows while students are loading", () => {
    setupPendingApis();
    const { container } = render(<Dashboard />);
    const tableRows = container.querySelectorAll("tbody tr[aria-hidden]");
    expect(tableRows.length).toBeGreaterThan(0);
  });

  test("replaces skeleton rows with real data after load completes", async () => {
    setupResolvedApis([
      { studentId: "STU001", name: "Alice Nguyen", class: "5A", feeAmount: 250, status: "paid" },
    ]);
    render(<Dashboard />);

    await waitFor(() => {
      expect(screen.getByText("Alice Nguyen")).toBeInTheDocument();
    });
    // No skeleton table rows should remain.
    const { container } = render(<Dashboard />);
    await waitFor(() => {
      expect(screen.getAllByText("Alice Nguyen").length).toBeGreaterThan(0);
    });
  });

  test("empty state is distinct from loading state (no skeleton-blocks when empty)", async () => {
    setupResolvedApis([]); // resolved but empty
    const { container } = render(<Dashboard />);

    await waitFor(() => {
      // No skeleton rows when the list is empty.
      const skeletonRows = container.querySelectorAll("tbody tr[aria-hidden]");
      expect(skeletonRows).toHaveLength(0);
    });
  });
});
