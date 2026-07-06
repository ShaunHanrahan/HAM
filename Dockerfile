FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/ShaunHanrahan/HAM"

WORKDIR /app

COPY --chown=node:node package.json server.js vendor.mjs ./
COPY --chown=node:node docker ./docker
COPY --chown=node:node public ./public

USER node
RUN node docker/prefetch-vendor.mjs

ENV PORT=10489
EXPOSE 10489

HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:'+(process.env.PORT||10489)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
