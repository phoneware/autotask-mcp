# --- build stage -------------------------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app

# Install deps against the lockfile first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript to dist/.
COPY tsconfig.json ./
COPY spec ./spec
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Drop devDependencies: keep only what runtime needs.

# --- runtime stage -----------------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the built-in unprivileged user.
USER node

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist

# Default transport is stdio. For HTTP, set AUTOTASK_TRANSPORT=http,
# AUTOTASK_HTTP_TOKEN and AUTOTASK_HTTP_HOST=0.0.0.0 (see README).
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
