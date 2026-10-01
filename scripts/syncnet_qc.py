#!/usr/bin/env python3
"""Optional SyncNet adapter for TikTokMoney deep lip-sync QC.

Requires:
  pip install -r requirements-lipsync.txt

Model weights are intentionally not bundled. Pass paths to the S3FD and SyncNet
weights explicitly so deployments can manage model provenance themselves.
"""

import argparse
import json
import sys


def as_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value]


def normalize_result(result, fps):
    if isinstance(result, dict):
        offsets = as_list(
            result.get("offsets")
            or result.get("offset_list")
            or result.get("offset")
        )
        confidences = as_list(
            result.get("confidences")
            or result.get("confidence_list")
            or result.get("confidence")
        )
        success = bool(result.get("success", True))
        model = result.get("model") or "syncnet-python"
    elif isinstance(result, (list, tuple)) and len(result) >= 2:
        # syncnet-python 0.2.x compatibility:
        # offset_list, confidence_list, min_dist_list, best_confidence,
        # best_min_dist, detections_json, success
        offsets = as_list(result[0])
        confidences = as_list(result[1])
        success = bool(result[6]) if len(result) > 6 else True
        model = "syncnet-python"
    else:
        raise RuntimeError("Unsupported SyncNet result shape")

    pairs = []
    for index in range(max(len(offsets), len(confidences))):
        offset = offsets[index] if index < len(offsets) else None
        confidence = confidences[index] if index < len(confidences) else None
        if offset is None or confidence is None:
            continue
        pairs.append({
            "offsetFrames": float(offset),
            "confidence": float(confidence),
        })

    if not success or not pairs:
        raise RuntimeError("SyncNet did not produce a valid synchronization result")

    best = max(pairs, key=lambda item: item["confidence"])

    return {
        "offsetFrames": best["offsetFrames"],
        "confidence": best["confidence"],
        "frameRate": float(fps),
        "segments": pairs,
        "evaluator": {
            "name": model,
            "mode": "frame-level-av-sync",
        },
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--s3fd-weights", required=True)
    parser.add_argument("--syncnet-weights", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--fps", type=float, default=25.0)
    args = parser.parse_args()

    try:
        from syncnet_python import SyncNetPipeline

        pipeline = SyncNetPipeline(
            s3fd_weights=args.s3fd_weights,
            syncnet_weights=args.syncnet_weights,
            device=args.device,
        )
        result = pipeline.inference(
            video_path=args.video,
            audio_path=None,
        )
        print(json.dumps(normalize_result(result, args.fps)))
    except Exception as exc:  # keep stdout machine-readable
        print(json.dumps({
            "error": str(exc),
            "evaluator": {
                "name": "syncnet-python",
                "mode": "frame-level-av-sync",
            },
        }))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
