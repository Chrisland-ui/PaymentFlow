export function reportRenderError(error, componentStack, context = {}) {
  const tracker = globalThis.paymentFlowErrorTracker || globalThis.Sentry;
  const details = {
    tags: { section: context.section || "application" },
    extra: {
      correlationId: context.correlationId,
      componentStack,
    },
  };

  if (typeof tracker?.captureException === "function") {
    tracker.captureException(error, details);
    return;
  }

  console.error("[ErrorBoundary] Unhandled render error", {
    ...details.extra,
    section: context.section || "application",
    error,
  });
}