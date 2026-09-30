# Operator dashboard production image. Build context is the repo root, because
# the dashboard depends on the workspace packages and the /contracts schemas.
FROM node:22-bookworm-slim

WORKDIR /app

# Install from the lockfile first so dependency layers cache across code changes.
# Dev dependencies stay installed: the build needs them, and the pre-deploy
# migration step runs node-pg-migrate from this image.
COPY package.json package-lock.json ./
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build -w apps/dashboard

ENV NODE_ENV=production
EXPOSE 3000
# srvx reads PORT from the environment (Railway sets it).
CMD ["npm", "start", "-w", "apps/dashboard"]
