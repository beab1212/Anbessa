# Build from the repo root so workspace libs (libs/*) are in the context:
#   docker build -f services/support-service/Dockerfile -t ride-app/support-service .
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# --- build stage ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline --filter @ride-app/support-service...
RUN pnpm --filter @ride-app/support-service... build
RUN pnpm --filter @ride-app/support-service deploy --prod --legacy /out

# --- runtime stage ---
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# a fixed id, so Kubernetes' runAsUser / runAsNonRoot can name it (infra/k8s/base)
RUN addgroup -S -g 10001 app && adduser -S -u 10001 app -G app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
USER app
EXPOSE 3009
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:3009/health || exit 1
CMD ["node", "dist/server.js"]
