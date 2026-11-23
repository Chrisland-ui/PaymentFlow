/**
 * Minimal next/navigation stub for the Jest node environment.
 */
const useRouter    = jest.fn(() => ({ replace: jest.fn(), push: jest.fn() }));
const usePathname  = jest.fn(() => "/");
const useSearchParams = jest.fn(() => new URLSearchParams());

module.exports = { useRouter, usePathname, useSearchParams };
