/**
 * Minimal next/router stub for the Jest node environment.
 *
 * Individual tests that need to control router state should call
 * jest.mock("next/router", ...) in their own file, which takes precedence over
 * this moduleNameMapper stub.
 *
 * Exported so tests can inspect calls to replace() via the shared mock fn.
 */
const mockReplace  = jest.fn();
const mockPush     = jest.fn();
const mockPrefetch = jest.fn(() => Promise.resolve());

const defaultRouter = {
  pathname:  "/",
  route:     "/",
  query:     {},
  asPath:    "/",
  isReady:   true,
  replace:   mockReplace,
  push:      mockPush,
  prefetch:  mockPrefetch,
  back:      jest.fn(),
  events:    { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
};

const useRouter = jest.fn(() => defaultRouter);

module.exports = { useRouter, __defaultRouter: defaultRouter };
