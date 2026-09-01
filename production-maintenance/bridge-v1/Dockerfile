FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

ARG OCI_SOURCE="https://github.com/meetroapp/metro-server"
ARG OCI_REVISION
ARG OCI_CREATED
ARG OCI_VERSION

LABEL org.opencontainers.image.source="${OCI_SOURCE}" \
      org.opencontainers.image.revision="${OCI_REVISION}" \
      org.opencontainers.image.created="${OCI_CREATED}" \
      org.opencontainers.image.version="${OCI_VERSION}" \
      org.opencontainers.image.title="Meetro immutable maintenance bridge" \
      org.opencontainers.image.description="Healthcheck-ready bridge that blocks all Meetro business traffic"

WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node server.js /app/server.js

USER node
EXPOSE 8080
CMD ["node", "/app/server.js"]
