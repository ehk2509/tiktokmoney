FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY examples ./examples

ENV PORT=3000
ENV OUTPUT_DIR=/app/outputs
ENV DATA_DIR=/app/data

EXPOSE 3000
CMD ["node", "src/server.js"]
