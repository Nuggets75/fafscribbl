# Optional. The normal deployment clones the repo at container start
# (see docker-compose.yml) and needs no image build at all.
FROM node:20-alpine
WORKDIR /srv/app
COPY . .
ENV PORT=8092 DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8092
CMD ["node", "server.js"]
