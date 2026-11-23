/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // Match every __tests__/*.test.js file under src/
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.[jt]s?(x)'],
  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
  },
  // Stub Next.js internals that are unavailable in the node test environment.
  // Individual test files may override these via jest.mock().
  moduleNameMapper: {
    '^next/router$': '<rootDir>/src/__mocks__/next/router.js',
    '^next/navigation$': '<rootDir>/src/__mocks__/next/navigation.js',
  },
  // Collect coverage for application source only — exclude tests and generated
  // files. Coverage is reported for lines, statements, functions AND branches
  // (the per-branch view is what surfaces unexecuted error/failover paths).
  collectCoverageFrom: [
    'src/**/*.{js,jsx,ts,tsx}',
    '!src/**/*.test.{js,jsx,ts,tsx}',
    '!src/**/__tests__/**',
    '!src/**/*.d.ts',
  ],
  coverageReporters: ['text', 'text-summary', 'lcov', 'json-summary', 'html', 'cobertura'],
  coverageDirectory: '../coverage/frontend',
  coverageThreshold: {
    global: {
      branches: 47,
      functions: 22,
      lines: 39,
      statements: 38,
    },
  },
};
