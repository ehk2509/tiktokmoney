FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    ffmpeg \
    fonts-dejavu-core \
    python3 \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/pose-sidecar-requirements.txt ./scripts/pose-sidecar-requirements.txt
COPY scripts/mediapipe_pose_extractor.py ./scripts/mediapipe_pose_extractor.py

RUN python3 -m venv /opt/tiktokmoney-pose \
  && /opt/tiktokmoney-pose/bin/pip install --no-cache-dir -r scripts/pose-sidecar-requirements.txt \
  && mkdir -p /app/models \
  && /opt/tiktokmoney-pose/bin/python scripts/mediapipe_pose_extractor.py \
      --download-model-only \
      --model /app/models/pose_landmarker_full.task \
  && /opt/tiktokmoney-pose/bin/python scripts/mediapipe_pose_extractor.py \
      --check \
      --model /app/models/pose_landmarker_full.task

COPY package.json ./
COPY src ./src
COPY docs ./docs
COPY examples ./examples
COPY scripts ./scripts

ENV PORT=3000
ENV OUTPUT_DIR=/app/outputs
ENV DATA_DIR=/app/data
ENV POSE_MODEL_PATH=/app/models/pose_landmarker_full.task
ENV POSE_CACHE_DIR=/app/data/pose-cache

EXPOSE 3000
CMD ["node", "src/server.js"]
