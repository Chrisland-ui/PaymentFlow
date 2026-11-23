'use strict';

const frontendUrl = process.argv[2] || process.env.FRONTEND_URL;

if (!frontendUrl) {
  console.error('Usage: node scripts/check-frontend-security-headers.js <frontend-url>');
  process.exit(2);
}

async function main() {
  const response = await fetch(frontendUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    throw new Error(`Frontend returned HTTP ${response.status}`);
  }

  const checks = [
    ['Content-Security-Policy', (value) =>
      value.includes('default-src') && value.includes('frame-ancestors')],
    ['Content-Security-Policy-Report-Only', (value) =>
      value.includes('default-src') && value.includes('report-uri /api/csp-report')],
    ['Strict-Transport-Security', (value) =>
      Number(value.match(/max-age=(\d+)/i)?.[1] || 0) >= 31536000 && /includesubdomains/i.test(value)],
    ['X-Frame-Options', (value) => value.toLowerCase() === 'deny'],
    ['X-Content-Type-Options', (value) => value.toLowerCase() === 'nosniff'],
    ['Referrer-Policy', (value) => value.toLowerCase() === 'strict-origin-when-cross-origin'],
  ];

  const failures = [];
  for (const [name, validate] of checks) {
    const value = response.headers.get(name);
    if (!value || !validate(value.toLowerCase())) {
      failures.push(`${name}: ${value || 'missing'}`);
    }
  }

  if (failures.length) {
    throw new Error(`Security header check failed:\n${failures.join('\n')}`);
  }

  const reportResponse = await fetch(new URL('/api/csp-report', frontendUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/csp-report' },
    body: JSON.stringify({
      'csp-report': {
        'document-uri': new URL(frontendUrl).href,
        'violated-directive': 'script-src',
        'effective-directive': 'script-src',
        'blocked-uri': 'inline',
        disposition: 'report',
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (reportResponse.status !== 204) {
    throw new Error(`CSP report endpoint returned HTTP ${reportResponse.status}, expected 204`);
  }

  console.log(`All security headers are present at ${new URL(frontendUrl).origin}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});