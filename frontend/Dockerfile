# ── Stage 1: install dependencies ────────────────────────────
# Separate layer so npm ci is cached independently of source changes.
FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN npm ci

# ── Stage 2: build ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Reuse the installed node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# NEXT_PUBLIC_* vars are inlined at build time — must be available here
ARG NEXT_PUBLIC_API_URL=http://localhost:5000/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

ARG NEXT_PUBLIC_STELLAR_NETWORK=testnet
ENV NEXT_PUBLIC_STELLAR_NETWORK=$NEXT_PUBLIC_STELLAR_NETWORK

COPY . .
RUN npm run build

# ── Stage 3: runtime image ────────────────────────────────────
FROM node:20-alpine AS runner

# Non-root user — principle of least privilege
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only what Next.js needs to serve the built app
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
