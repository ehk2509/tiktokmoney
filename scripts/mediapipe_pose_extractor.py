#!/usr/bin/env python3
"""Bundled MediaPipe Pose Landmarker sidecar for TikTokMoney.

Input video frames are decoded with ffmpeg. MediaPipe only performs pose inference,
so TikTokMoney does not need OpenCV as an additional sidecar dependency.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

DEFAULT_MODEL_URL = (
    "https://storage.googleapis.com/mediapipe-models/"
    "pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task"
)

LANDMARK_NAMES = [
    "nose",
    "left_eye_inner",
    "left_eye",
    "left_eye_outer",
    "right_eye_inner",
    "right_eye",
    "right_eye_outer",
    "left_ear",
    "right_ear",
    "mouth_left",
    "mouth_right",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_pinky",
    "right_pinky",
    "left_index",
    "right_index",
    "left_thumb",
    "right_thumb",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
    "left_heel",
    "right_heel",
    "left_foot_index",
    "right_foot_index",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract timestamped MediaPipe pose landmarks")
    parser.add_argument("--video")
    parser.add_argument("--output-json")
    parser.add_argument("--fps", type=float, default=8.0)
    parser.add_argument("--duration", type=float)
    parser.add_argument(
        "--model",
        default=os.environ.get("POSE_MODEL_PATH", "models/pose_landmarker_full.task"),
    )
    parser.add_argument("--model-url", default=DEFAULT_MODEL_URL)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "ffmpeg"))
    parser.add_argument("--ffprobe", default=os.environ.get("FFPROBE_BIN", "ffprobe"))
    parser.add_argument("--min-detection-confidence", type=float, default=0.45)
    parser.add_argument("--min-presence-confidence", type=float, default=0.45)
    parser.add_argument("--min-tracking-confidence", type=float, default=0.45)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--download-model-only", action="store_true")
    return parser.parse_args()


def ensure_model(path: pathlib.Path, url: str) -> pathlib.Path:
    if path.exists() and path.stat().st_size > 1024:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_suffix(path.suffix + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=90) as response:
            with partial.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
        if partial.stat().st_size <= 1024:
            raise RuntimeError("downloaded pose model is unexpectedly small")
        partial.replace(path)
        return path
    finally:
        if partial.exists():
            partial.unlink(missing_ok=True)


def require_mediapipe():
    try:
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
    except Exception as exc:
        raise RuntimeError(
            "MediaPipe is not installed. Run: npm run setup:pose"
        ) from exc
    return mp, mp_python, vision


def probe_duration(video: str, ffprobe: str) -> float:
    completed = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nokey=1:noprint_wrappers=1",
            video,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = float(completed.stdout.strip())
    if not math.isfinite(value) or value <= 0:
        raise RuntimeError("ffprobe returned invalid video duration")
    return value


def extract_frames(
    video: str,
    work_dir: pathlib.Path,
    fps: float,
    duration: float | None,
    ffmpeg: str,
) -> list[pathlib.Path]:
    output_pattern = str(work_dir / "frame-%06d.jpg")
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        video,
    ]
    if duration is not None and duration > 0:
        command.extend(["-t", f"{duration:.6f}"])
    command.extend([
        "-vf",
        f"fps={fps:.6f}",
        "-q:v",
        "3",
        "-vsync",
        "0",
        output_pattern,
    ])
    subprocess.run(command, check=True)
    return sorted(work_dir.glob("frame-*.jpg"))


def confidence_of(landmark) -> float:
    values = []
    for key in ("visibility", "presence"):
        value = getattr(landmark, key, None)
        if value is not None and math.isfinite(float(value)):
            values.append(float(value))
    if not values:
        return 1.0
    return max(0.0, min(1.0, min(values)))


def landmark_payload(landmark) -> dict:
    return {
        "x": round(float(landmark.x), 6),
        "y": round(float(landmark.y), 6),
        "z": round(float(getattr(landmark, "z", 0.0) or 0.0), 6),
        "confidence": round(confidence_of(landmark), 6),
    }


def extract_pose(
    video: str,
    model_path: pathlib.Path,
    output_json: str,
    fps: float,
    duration: float,
    ffmpeg: str,
    min_detection_confidence: float,
    min_presence_confidence: float,
    min_tracking_confidence: float,
) -> dict:
    mp, mp_python, vision = require_mediapipe()

    with tempfile.TemporaryDirectory(prefix="tiktokmoney-pose-frames-") as tmp:
        frame_paths = extract_frames(
            video=video,
            work_dir=pathlib.Path(tmp),
            fps=fps,
            duration=duration,
            ffmpeg=ffmpeg,
        )
        if not frame_paths:
            raise RuntimeError("ffmpeg did not produce any frames for pose extraction")

        options = vision.PoseLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
            running_mode=vision.RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=min_detection_confidence,
            min_pose_presence_confidence=min_presence_confidence,
            min_tracking_confidence=min_tracking_confidence,
            output_segmentation_masks=False,
        )

        frames = []
        with vision.PoseLandmarker.create_from_options(options) as detector:
            previous_timestamp_ms = -1
            for index, frame_path in enumerate(frame_paths):
                timestamp_seconds = index / fps
                timestamp_ms = max(
                    previous_timestamp_ms + 1,
                    int(round(timestamp_seconds * 1000)),
                )
                previous_timestamp_ms = timestamp_ms
                image = mp.Image.create_from_file(str(frame_path))
                result = detector.detect_for_video(image, timestamp_ms)
                if not result.pose_landmarks:
                    frames.append({
                        "time": round(timestamp_seconds, 6),
                        "joints": {},
                    })
                    continue

                pose = result.pose_landmarks[0]
                joints = {}
                for landmark_index, landmark in enumerate(pose):
                    if landmark_index >= len(LANDMARK_NAMES):
                        break
                    joints[LANDMARK_NAMES[landmark_index]] = landmark_payload(landmark)

                frames.append({
                    "time": round(timestamp_seconds, 6),
                    "joints": joints,
                })

    payload = {
        "schemaVersion": 1,
        "extractor": "mediapipe-pose-landmarker",
        "mediapipeVersion": getattr(mp, "__version__", "unknown"),
        "model": model_path.name,
        "sampleFps": fps,
        "durationSeconds": round(duration, 6),
        "frames": frames,
        "contacts": [],
    }
    output_path = pathlib.Path(output_json)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return payload


def main() -> int:
    args = parse_args()
    model_path = ensure_model(pathlib.Path(args.model), args.model_url)

    if args.download_model_only:
        print(str(model_path))
        return 0

    if args.check:
        mp, _, _ = require_mediapipe()
        print(json.dumps({
            "ok": True,
            "backend": "mediapipe-pose-landmarker",
            "mediapipeVersion": getattr(mp, "__version__", "unknown"),
            "model": str(model_path),
        }))
        return 0

    if not args.video or not args.output_json:
        raise RuntimeError("--video and --output-json are required")

    fps = max(2.0, min(30.0, float(args.fps)))
    duration = args.duration
    if duration is None or not math.isfinite(duration) or duration <= 0:
        duration = probe_duration(args.video, args.ffprobe)

    extract_pose(
        video=args.video,
        model_path=model_path,
        output_json=args.output_json,
        fps=fps,
        duration=duration,
        ffmpeg=args.ffmpeg,
        min_detection_confidence=args.min_detection_confidence,
        min_presence_confidence=args.min_presence_confidence,
        min_tracking_confidence=args.min_tracking_confidence,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"pose extractor failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
