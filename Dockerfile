# syntax=docker/dockerfile:1

FROM node:22.23.1-bookworm-slim

WORKDIR /app

ARG OCI_SOURCE
ARG OCI_REVISION
ARG OCI_CREATED
ARG OCI_VERSION
ARG PACKAGING_REVISION

LABEL org.opencontainers.image.source=$OCI_SOURCE \
      org.opencontainers.image.revision=$OCI_REVISION \
      org.opencontainers.image.created=$OCI_CREATED \
      org.opencontainers.image.version=$OCI_VERSION \
      io.meetro.packaging.revision=$PACKAGING_REVISION

ENV NODE_ENV=production \
    GIT_COMMIT=$OCI_REVISION

COPY package.json package-lock.json ./
RUN test -n "$OCI_SOURCE" \
    && test -n "$OCI_REVISION" \
    && test -n "$OCI_CREATED" \
    && test -n "$OCI_VERSION" \
    && test -n "$PACKAGING_REVISION" \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health', response => process.exit(response.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
