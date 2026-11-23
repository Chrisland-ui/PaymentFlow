/**
 * Browser-safe download utilities for blob-based file downloads.
 *
 * Centralises object URL lifecycle (create → use → revoke) and
 * server-provided filename extraction from Content-Disposition headers.
 *
 * Issue #14 – Add browser-safe download handling for reports.
 */

/**
 * Sanitise a candidate filename so it cannot contain path-traversal sequences
 * or shell-unsafe characters.  Only alphanumerics, hyphens, underscores, and
 * dots are preserved; everything else is stripped.
 *
 * @param {string} name - Raw filename string.
 * @returns {string} Sanitised filename, or empty string when nothing survives.
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== "string") return "";
  // Remove leading/trailing whitespace and quotes first.
  const trimmed = name.trim().replace(/^['"]|['"]$/g, "");
  // Strip directory separators and path-traversal sequences.
  const noPath = trimmed.replace(/[/\\]/g, "").replace(/\.\./g, "");
  // Allow spaces in valid names while still stripping unsafe characters.
  return noPath.replace(/[^a-zA-Z0-9._ -]/g, "").trim();
}

/**
 * Attempt to read a server-supplied filename from a `Content-Disposition`
 * response header.  Both the plain `filename=` token and the RFC 5987
 * extended `filename*=UTF-8''<percent-encoded>` form are supported.
 *
 * Returns `fallback` when:
 *  - the header is absent,
 *  - no filename token is found,
 *  - the extracted value is empty after sanitisation.
 *
 * @param {Response} response - Fetch API Response object.
 * @param {string}   fallback - Value to return when no safe name is found.
 * @returns {string}
 */
export function getServerFilename(response, fallback) {
  try {
    const disposition = response.headers && response.headers.get
      ? response.headers.get("content-disposition")
      : null;

    if (!disposition) return fallback;

    // RFC 5987 extended syntax  (filename*=UTF-8''encoded%20name.csv)
    const extMatch = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(disposition);
    if (extMatch) {
      const decoded = decodeURIComponent(extMatch[1]);
      const safe    = sanitizeFilename(decoded);
      if (safe) return safe;
    }

    // Plain  filename="name.csv"  or  filename=name.csv
    const plainMatch = /filename\s*=\s*([^;]+)/i.exec(disposition);
    if (plainMatch) {
      const safe = sanitizeFilename(plainMatch[1]);
      if (safe) return safe;
    }
  } catch {
    // Malformed header — fall through to the fallback.
  }

  return fallback;
}

/**
 * Trigger a browser download for `blob` using a temporary anchor element.
 *
 * The object URL is always revoked — even when the click or append/remove
 * cycle throws — to prevent memory leaks.
 *
 * @param {Blob}   blob     - Blob to download.
 * @param {string} filename - Suggested filename for the download dialogue.
 */
export function downloadBlob(blob, filename) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href     = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** Start a browser-managed download without buffering the file in JavaScript. */
export function downloadFile(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
