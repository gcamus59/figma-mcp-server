# =============================================================================
# Stage 1 – build
# Install all dependencies (including dev), compile TypeScript to dist/.
# =============================================================================
FROM node:22-alpine AS build

WORKDIR /app

# Copy manifests first for layer-cache efficiency.
# --ignore-scripts prevents the postinstall hook from running `tsc` before
# the source files are present.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Copy source and compile
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# =============================================================================
# Stage 2 – runtime
# Lean image: only production deps + compiled output.
# Runs as a non-root user for least-privilege execution.
# =============================================================================
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Install production dependencies only.
# --ignore-scripts skips the postinstall hook (which calls `tsc`) because
# the compiled output is already copied from the build stage.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output and the root entry-point from the build stage
COPY --from=build /app/dist ./dist
COPY server.js ./

# Create a non-root user/group with an explicit numeric UID/GID.
# Using a numeric USER is required for Kubernetes runAsNonRoot verification,
# which cannot resolve named users from the image manifest at admission time.
RUN addgroup -S -g 1001 appgroup && adduser -S -u 1001 -G appgroup appuser
USER 1001

# Expose the HTTP/SSE port
EXPOSE 3000

# The server listens on port 3000 (HTTP/SSE transport).
# FIGMA_ACCESS_TOKEN must be provided as an environment variable at runtime
# (e.g. via a Kubernetes Secret or `docker run -e FIGMA_ACCESS_TOKEN=...`).
# Pass --stdio to use stdio transport instead (e.g. for Claude Desktop).
CMD ["node", "server.js"]
