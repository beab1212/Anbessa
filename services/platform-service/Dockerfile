# Build from the repo root so workspace libs (libs/*) are in the context:
#   docker build -f services/platform-service/Dockerfile -t ride-app/platform-service .
FROM node:24-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# --- build stage ---
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --offline --filter @ride-app/platform-service...
RUN pnpm --filter @ride-app/platform-service... build
RUN pnpm --filter @ride-app/platform-service deploy --prod --legacy /out

# --- runtime stage ---
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/package.json ./
USER app
EXPOSE 3011
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://localhost:3011/health || exit 1
CMD ["node", "dist/server.js"]
