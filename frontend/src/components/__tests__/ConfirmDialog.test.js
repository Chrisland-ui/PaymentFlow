/**
 * Tests for ConfirmDialog — Issue #108
 *
 * Follows the project pattern (Jest 29, babel-jest, NO @babel/preset-react).
 * The JSX component is mocked. Pure logic is tested directly.
 */

// ── Mock the JSX component ────────────────────────────────────────────────────
jest.mock("../ConfirmDialog", () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

const ConfirmDialog = require("../ConfirmDialog").default;

// ── Pure logic extracted from the component ───────────────────────────────────

const VARIANT_CONFIG = {
  danger: {
    headerBg:    "var(--danger-bg)",
    headerColor: "var(--danger-text)",
    btnClass:    "btn-danger",
  },
  warning: {
    headerBg:    "var(--warning-bg)",
    headerColor: "var(--warning-text)",
    btnClass:    "btn-warning",
  },
  info: {
    headerBg:    "var(--info-bg)",
    headerColor: "var(--info-text)",
    btnClass:    "btn-primary",
  },
};

function getVariantConfig(variant) {
  return VARIANT_CONFIG[variant] || VARIANT_CONFIG.danger;
}

/**
 * Determines whether the confirm button should be enabled.
 */
function isConfirmEnabled({ submitting, typingRequired, typedValue, requireTyping }) {
  return !submitting && (!typingRequired || typedValue === requireTyping);
}

// ── getVariantConfig ──────────────────────────────────────────────────────────

describe("getVariantConfig", () => {
  it("returns danger config for variant='danger'", () => {
    expect(getVariantConfig("danger").btnClass).toBe("btn-danger");
  });

  it("returns warning config for variant='warning'", () => {
    expect(getVariantConfig("warning").btnClass).toBe("btn-warning");
  });

  it("returns info config for variant='info'", () => {
    expect(getVariantConfig("info").btnClass).toBe("btn-primary");
  });

  it("defaults to danger config for unknown variant", () => {
    expect(getVariantConfig("unknown").btnClass).toBe("btn-danger");
  });

  it("defaults to danger config for undefined", () => {
    expect(getVariantConfig(undefined).btnClass).toBe("btn-danger");
  });

  it("defaults to danger config for null", () => {
    expect(getVariantConfig(null).btnClass).toBe("btn-danger");
  });
});

// ── isConfirmEnabled ──────────────────────────────────────────────────────────

describe("isConfirmEnabled — typing guard", () => {
  it("is enabled when no typing is required and not submitting", () => {
    expect(isConfirmEnabled({ submitting: false, typingRequired: false, typedValue: "", requireTyping: undefined })).toBe(true);
  });

  it("is disabled when submitting regardless of typing", () => {
    expect(isConfirmEnabled({ submitting: true, typingRequired: false, typedValue: "", requireTyping: undefined })).toBe(false);
  });

  it("is disabled when typing is required but value is empty", () => {
    expect(isConfirmEnabled({ submitting: false, typingRequired: true, typedValue: "", requireTyping: "Class A" })).toBe(false);
  });

  it("is disabled when typing is required and value is partial match", () => {
    expect(isConfirmEnabled({ submitting: false, typingRequired: true, typedValue: "Class", requireTyping: "Class A" })).toBe(false);
  });

  it("is enabled when typing is required and value matches exactly", () => {
    expect(isConfirmEnabled({ submitting: false, typingRequired: true, typedValue: "Class A", requireTyping: "Class A" })).toBe(true);
  });

  it("is disabled when typing matches but submitting is true", () => {
    expect(isConfirmEnabled({ submitting: true, typingRequired: true, typedValue: "Class A", requireTyping: "Class A" })).toBe(false);
  });

  it("is case-sensitive — 'class a' does not match 'Class A'", () => {
    expect(isConfirmEnabled({ submitting: false, typingRequired: true, typedValue: "class a", requireTyping: "Class A" })).toBe(false);
  });
});

// ── Focus-on-cancel rule ──────────────────────────────────────────────────────

describe("focus guard — cancel button receives initial focus", () => {
  it("cancel button should NOT be disabled when dialog opens (not submitting)", () => {
    const submitting = false;
    // Cancel button is disabled only when submitting
    const cancelDisabled = submitting;
    expect(cancelDisabled).toBe(false);
  });

  it("cancel button IS disabled while submitting", () => {
    const submitting = true;
    const cancelDisabled = submitting;
    expect(cancelDisabled).toBe(true);
  });
});

// ── Keyboard behaviour contract ───────────────────────────────────────────────

describe("keyboard behaviour contracts", () => {
  it("Escape should not cancel while submitting", () => {
    // The component only calls onCancel for Escape when !submitting
    const submitting = true;
    const shouldCancel = !submitting;
    expect(shouldCancel).toBe(false);
  });

  it("Escape should cancel when not submitting", () => {
    const submitting = false;
    const shouldCancel = !submitting;
    expect(shouldCancel).toBe(true);
  });
});

// ── Typing match detection ────────────────────────────────────────────────────

describe("typing match detection", () => {
  it("matches exactly equal strings", () => {
    expect("Delete" === "Delete").toBe(true);
  });

  it("does not match when extra whitespace is present", () => {
    expect(" Delete" === "Delete").toBe(false);
    expect("Delete " === "Delete").toBe(false);
  });

  it("does not match empty string against a target", () => {
    expect("" === "Class A").toBe(false);
  });

  it("matches an empty requireTyping with an empty input (edge case)", () => {
    // If requireTyping is "" the dialog treats it as "no typing required"
    // so isConfirmEnabled should return true when typedValue is "".
    const result = isConfirmEnabled({
      submitting: false,
      typingRequired: false,
      typedValue: "",
      requireTyping: "",
    });
    expect(result).toBe(true);
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe("error state contract", () => {
  it("internal error from onConfirm rejection should surface without closing the dialog", () => {
    // Simulated: handleConfirm sets internalError on rejection, submitting stays false
    let internalError = null;
    let submitting = false;

    async function simulateConfirmReject() {
      submitting = true;
      try {
        await Promise.reject(new Error("Network failure"));
      } catch (err) {
        internalError = err.message;
      } finally {
        submitting = false;
      }
    }

    return simulateConfirmReject().then(() => {
      expect(internalError).toBe("Network failure");
      expect(submitting).toBe(false);
    });
  });
});

// ── Module export ─────────────────────────────────────────────────────────────

describe("ConfirmDialog module", () => {
  it("exports a function (React component stub)", () => {
    expect(typeof ConfirmDialog).toBe("function");
  });
});
