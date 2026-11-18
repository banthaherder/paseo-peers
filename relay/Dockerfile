FROM node:24-alpine
WORKDIR /app
COPY package.json server.mjs ./
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production PORT=6767 HOST=0.0.0.0 DATA_DIR=/data
VOLUME /data
EXPOSE 6767
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:6767/v1/health || exit 1
CMD ["node", "server.mjs"]
