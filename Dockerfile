# syntax=docker/dockerfile:1
# Multi-stage build for Scrambler. The final image contains only the runtime
# Node.js + Python dependencies and no build toolchain.

# Pin the base image by digest. This is node:22-slim (Debian Bookworm).
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS builder

WORKDIR /app

# Install the minimum packages needed to build Python dependencies.
# No poppler/pdfinfo is installed; PyMuPDF bundles MuPDF.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Create a virtual environment so Python packages can be copied cleanly to the
# final image without dragging in build-only files.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# -----------------------------------------------------------------------------
FROM node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS final

WORKDIR /app

# The application spawns `python3`; install only the interpreter, not pip/gcc.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
  && rm -rf /var/lib/apt/lists/*

# Copy the virtual environment and the application from the builder stage.
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/public ./public

ENV PATH="/opt/venv/bin:${PATH}"
ENV NODE_ENV=production
ENV PORT=3057

# Run as the non-root user supplied by the Node image.
RUN chown -R node:node /app
USER node

EXPOSE 3057

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3057/health', (r) => { r.on('data', () => {}); r.on('end', () => process.exit(r.statusCode === 200 ? 0 : 1)); }).on('error', () => process.exit(1));"

CMD ["node", "src/server.js"]
