# ── Stage 1: production dependencies ─────────────────────────
# Install only production dependencies so the final image never
# includes jest, eslint, or other dev-only packages.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 2: build ────────────────────────────────────────────
# Full install (including devDependencies) is available here for
# any transpile or codegen steps.  Only source artefacts are
# carried forward — dev node_modules stay in this layer.
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY src/ ./src/

# ── Stage 3: runtime image ────────────────────────────────────
FROM node:20-alpine AS runtime

# Install curl for the HEALTHCHECK below
RUN apk add --no-cache curl

# Non-root user — principle of least privilege
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Application source from the build stage
COPY --from=build /app/src ./src

# Database migrations and the deploy-time migration CLI. These MUST be in
# the image: the migration runner fails loudly if migrations/ is absent, and
# the deployment runs `npm run migrate` before serving traffic (see
# deploy/k8s/backend-deployment.yaml initContainer and docs/migrations.md).
COPY migrations/ ./migrations/
COPY scripts/ ./scripts/

# package.json is needed so `npm start` resolves the start script
COPY package*.json ./

# Transfer ownership to the non-root user before switching to it
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 5000

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -f http://localhost:${PORT:-5000}/health || exit 1

CMD ["npm", "start"]
