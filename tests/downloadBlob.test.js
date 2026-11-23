/**
 * @jest-environment jsdom
 *
 * Tests for the downloadBlob utility module (issue #14).
 *
 * Covers:
 *  - downloadBlob  – object URL lifecycle and anchor element handling
 *  - getServerFilename – Content-Disposition parsing and filename sanitisation
 */

"use strict";

import { downloadBlob, getServerFilename } from "../frontend/src/utils/downloadBlob";

// ── Shared mocks ──────────────────────────────────────────────────────────────

const FAKE_BLOB_URL = "blob:http://localhost/fake-1234";

beforeEach(() => {
  // Mock URL object-URL helpers.
  global.URL.createObjectURL = jest.fn(() => FAKE_BLOB_URL);
  global.URL.revokeObjectURL = jest.fn();

  // Spy on body methods so we can verify elements are appended and removed.
  jest.spyOn(document.body, "appendChild").mockImplementation(() => {});
  jest.spyOn(document.body, "removeChild").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── downloadBlob ──────────────────────────────────────────────────────────────

describe("downloadBlob", () => {
  test("creates an object URL from the supplied blob", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    downloadBlob(blob, "report.csv");
    expect(URL.createObjectURL).toHaveBeenCalledWith(blob);
  });

  test("sets href and download attribute on the anchor element", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    const elements = [];
    // Capture every created element so we can inspect the <a> tag.
    jest.spyOn(document, "createElement").mockImplementation((tag) => {
      const el = { href: "", download: "", click: jest.fn() };
      elements.push({ tag, el });
      return el;
    });

    downloadBlob(blob, "my-report.csv");

    const anchor = elements.find((e) => e.tag === "a");
    expect(anchor).toBeDefined();
    expect(anchor.el.href).toBe(FAKE_BLOB_URL);
    expect(anchor.el.download).toBe("my-report.csv");
  });

  test("appends the anchor to the body and removes it", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    downloadBlob(blob, "report.csv");
    expect(document.body.appendChild).toHaveBeenCalledTimes(1);
    expect(document.body.removeChild).toHaveBeenCalledTimes(1);
  });

  test("clicks the anchor to trigger the download", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    let clickCalled = false;
    jest.spyOn(document, "createElement").mockReturnValue({
      href: "",
      download: "",
      click: () => { clickCalled = true; },
    });

    downloadBlob(blob, "report.csv");
    expect(clickCalled).toBe(true);
  });

  test("revokes the object URL after the click", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    downloadBlob(blob, "report.csv");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
  });

  test("revokes the object URL even when the click throws", () => {
    const blob = new Blob(["data"], { type: "text/csv" });
    jest.spyOn(document, "createElement").mockReturnValue({
      href: "",
      download: "",
      click: () => { throw new Error("click failed"); },
    });

    // Should not throw (revokeObjectURL in finally block).
    expect(() => downloadBlob(blob, "report.csv")).toThrow("click failed");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(FAKE_BLOB_URL);
  });
});

// ── getServerFilename ─────────────────────────────────────────────────────────

/** Helper to build a minimal Response-like object with the given header value. */
function makeResponse(contentDisposition) {
  const headers = {
    get: (name) => (name.toLowerCase() === "content-disposition" ? contentDisposition : null),
  };
  return { headers };
}

describe("getServerFilename", () => {
  test("returns fallback when Content-Disposition header is absent", () => {
    const response = makeResponse(null);
    expect(getServerFilename(response, "fallback.csv")).toBe("fallback.csv");
  });

  test("returns fallback when Content-Disposition has no filename token", () => {
    const response = makeResponse("attachment");
    expect(getServerFilename(response, "fallback.csv")).toBe("fallback.csv");
  });

  test("parses a plain filename= token", () => {
    const response = makeResponse('attachment; filename="report-jan.csv"');
    expect(getServerFilename(response, "fallback.csv")).toBe("report-jan.csv");
  });

  test("parses a plain filename= token without quotes", () => {
    const response = makeResponse("attachment; filename=report.csv");
    expect(getServerFilename(response, "fallback.csv")).toBe("report.csv");
  });

  test("parses an RFC 5987 filename*= token", () => {
    const response = makeResponse("attachment; filename*=UTF-8''report%20file.csv");
    expect(getServerFilename(response, "fallback.csv")).toBe("report file.csv");
  });

  test("prefers the extended filename*= form over plain filename=", () => {
    const response = makeResponse(
      'attachment; filename="plain.csv"; filename*=UTF-8\'\'extended.csv'
    );
    expect(getServerFilename(response, "fallback.csv")).toBe("extended.csv");
  });

  test("returns fallback when extracted filename sanitises to empty string", () => {
    // A filename made entirely of disallowed characters.
    const response = makeResponse('attachment; filename="../../"');
    expect(getServerFilename(response, "fallback.csv")).toBe("fallback.csv");
  });

  test("strips path traversal sequences from the filename", () => {
    const response = makeResponse('attachment; filename="../../etc/passwd.csv"');
    const result = getServerFilename(response, "fallback.csv");
    // Path separators and '..' must not survive.
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
    expect(result).not.toContain("..");
  });

  test("strips path separators from the filename", () => {
    const response = makeResponse('attachment; filename="reports/jan/data.csv"');
    const result = getServerFilename(response, "fallback.csv");
    expect(result).not.toContain("/");
    expect(result).not.toContain("\\");
  });

  test("returns fallback when headers object is missing", () => {
    const response = {};
    expect(getServerFilename(response, "fallback.csv")).toBe("fallback.csv");
  });

  test("returns fallback when response is null", () => {
    expect(getServerFilename(null, "fallback.csv")).toBe("fallback.csv");
  });

  test("handles malformed percent-encoded extended filename gracefully", () => {
    // Malformed percent-encoding that decodeURIComponent would throw on.
    const response = makeResponse("attachment; filename*=UTF-8''%C0%AF.csv");
    // Should not throw; falls back to plain filename or fallback.
    expect(() => getServerFilename(response, "fallback.csv")).not.toThrow();
  });
});
