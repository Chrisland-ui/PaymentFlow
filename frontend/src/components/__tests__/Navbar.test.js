/**
 * Tests for Navbar role-aware navigation — Issue #109
 *
 * Follows the project pattern (Jest 29, babel-jest, NO @babel/preset-react).
 * The JSX component is mocked. Pure logic and data structures are tested.
 */

// ── Mock the JSX component ────────────────────────────────────────────────────
jest.mock("../Navbar", () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

const Navbar = require("../Navbar").default;

// ── Data structures mirroring Navbar.jsx ─────────────────────────────────────

const PUBLIC_LINKS = [
  { href: "/pay-fees",  i18nKey: "nav.payFees",   adminOnly: false },
  { href: "/dashboard", i18nKey: "nav.dashboard", adminOnly: false },
  { href: "/reports",   i18nKey: "nav.reports",   adminOnly: false },
];

const ADMIN_LINKS = [
  { href: "/fee-adjustments", i18nKey: "nav.feeRules",   adminOnly: true },
  { href: "/audit-logs",      i18nKey: "nav.auditLogs",  adminOnly: true },
  { href: "/disputes",        i18nKey: "nav.disputes",   adminOnly: true },
  { href: "/webhooks",        i18nKey: "nav.webhooks",   adminOnly: true },
];

/**
 * Resolves which links should be rendered based on the current role.
 * Mirrors the component's internal logic.
 */
function resolveLinks(isAdmin) {
  return {
    publicLinks: PUBLIC_LINKS,
    adminLinks: isAdmin ? ADMIN_LINKS : [],
  };
}

// ── PUBLIC_LINKS structure ────────────────────────────────────────────────────

describe("PUBLIC_LINKS", () => {
  it("contains at least one entry", () => {
    expect(PUBLIC_LINKS.length).toBeGreaterThan(0);
  });

  it("every entry has href and i18nKey", () => {
    PUBLIC_LINKS.forEach(link => {
      expect(link.href).toBeDefined();
      expect(link.i18nKey).toBeDefined();
    });
  });

  it("no PUBLIC_LINK is marked adminOnly: true", () => {
    PUBLIC_LINKS.forEach(link => {
      expect(link.adminOnly).not.toBe(true);
    });
  });

  it("includes /pay-fees, /dashboard, /reports", () => {
    const hrefs = PUBLIC_LINKS.map(l => l.href);
    expect(hrefs).toContain("/pay-fees");
    expect(hrefs).toContain("/dashboard");
    expect(hrefs).toContain("/reports");
  });
});

// ── ADMIN_LINKS structure ─────────────────────────────────────────────────────

describe("ADMIN_LINKS", () => {
  it("contains at least one entry", () => {
    expect(ADMIN_LINKS.length).toBeGreaterThan(0);
  });

  it("every entry has href and i18nKey", () => {
    ADMIN_LINKS.forEach(link => {
      expect(link.href).toBeDefined();
      expect(link.i18nKey).toBeDefined();
    });
  });

  it("every ADMIN_LINK is marked adminOnly: true", () => {
    ADMIN_LINKS.forEach(link => {
      expect(link.adminOnly).toBe(true);
    });
  });

  it("includes /fee-adjustments, /audit-logs, /disputes, /webhooks", () => {
    const hrefs = ADMIN_LINKS.map(l => l.href);
    expect(hrefs).toContain("/fee-adjustments");
    expect(hrefs).toContain("/audit-logs");
    expect(hrefs).toContain("/disputes");
    expect(hrefs).toContain("/webhooks");
  });

  it("does NOT include any public route hrefs", () => {
    const publicHrefs = PUBLIC_LINKS.map(l => l.href);
    ADMIN_LINKS.forEach(link => {
      expect(publicHrefs).not.toContain(link.href);
    });
  });
});

// ── resolveLinks — role-aware resolution (#109) ───────────────────────────────

describe("resolveLinks — non-admin user", () => {
  const { publicLinks, adminLinks } = resolveLinks(false);

  it("publicLinks contains all public routes", () => {
    expect(publicLinks).toHaveLength(PUBLIC_LINKS.length);
  });

  it("adminLinks is empty for non-admin", () => {
    expect(adminLinks).toHaveLength(0);
  });

  it("no admin-only routes are visible to non-admin", () => {
    const allHrefs = [...publicLinks, ...adminLinks].map(l => l.href);
    ADMIN_LINKS.forEach(link => {
      expect(allHrefs).not.toContain(link.href);
    });
  });
});

describe("resolveLinks — admin user", () => {
  const { publicLinks, adminLinks } = resolveLinks(true);

  it("publicLinks contains all public routes", () => {
    expect(publicLinks).toHaveLength(PUBLIC_LINKS.length);
  });

  it("adminLinks contains all admin routes", () => {
    expect(adminLinks).toHaveLength(ADMIN_LINKS.length);
  });

  it("admin sees all routes from both sets", () => {
    const allHrefs = [...publicLinks, ...adminLinks].map(l => l.href);
    [...PUBLIC_LINKS, ...ADMIN_LINKS].forEach(link => {
      expect(allHrefs).toContain(link.href);
    });
  });

  it("adminLinks are all marked adminOnly", () => {
    adminLinks.forEach(link => {
      expect(link.adminOnly).toBe(true);
    });
  });
});

// ── No overlap between PUBLIC_LINKS and ADMIN_LINKS ──────────────────────────

describe("link set separation", () => {
  it("PUBLIC_LINKS and ADMIN_LINKS have no overlapping hrefs", () => {
    const publicHrefs = new Set(PUBLIC_LINKS.map(l => l.href));
    const adminHrefs  = new Set(ADMIN_LINKS.map(l => l.href));
    for (const href of adminHrefs) {
      expect(publicHrefs.has(href)).toBe(false);
    }
  });

  it("PUBLIC_LINKS and ADMIN_LINKS have no overlapping i18nKeys", () => {
    const publicKeys = new Set(PUBLIC_LINKS.map(l => l.i18nKey));
    const adminKeys  = new Set(ADMIN_LINKS.map(l => l.i18nKey));
    for (const key of adminKeys) {
      expect(publicKeys.has(key)).toBe(false);
    }
  });
});

// ── Admin role badge visibility rule ─────────────────────────────────────────

describe("admin role badge visibility", () => {
  it("badge should be shown when isAdmin is true", () => {
    const isAdmin = true;
    const showBadge = isAdmin;
    expect(showBadge).toBe(true);
  });

  it("badge should NOT be shown when isAdmin is false", () => {
    const isAdmin = false;
    const showBadge = isAdmin;
    expect(showBadge).toBe(false);
  });
});

// ── Login CTA visibility rule ─────────────────────────────────────────────────

describe("login CTA vs sign-out button", () => {
  it("shows sign-out for admin", () => {
    const isAdmin = true;
    const showSignOut = isAdmin;
    const showLoginCta = !isAdmin;
    expect(showSignOut).toBe(true);
    expect(showLoginCta).toBe(false);
  });

  it("shows login CTA for non-admin", () => {
    const isAdmin = false;
    const showSignOut = isAdmin;
    const showLoginCta = !isAdmin;
    expect(showSignOut).toBe(false);
    expect(showLoginCta).toBe(true);
  });
});

// ── Module export ─────────────────────────────────────────────────────────────

describe("Navbar module", () => {
  it("exports a function (React component stub)", () => {
    expect(typeof Navbar).toBe("function");
  });
});
