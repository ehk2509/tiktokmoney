#!/usr/bin/env python3
"""TikTokMoney local phoneme↔viseme verifier.

Expected speech units:
  independent transcript word timestamps -> CMUdict ARPAbet phonemes
  -> Meta/Oculus-style 15-viseme labels -> visually distinguishable families

Observed speech units:
  generated video -> MediaPipe FaceMesh mouth landmarks
  -> normalized geometry -> prototype classifier -> visual mouth family

The classifier intentionally merges visually ambiguous phonemes into macro-viseme
families instead of claiming distinctions the mouth geometry cannot reliably show.
"""

import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict

import cv2
import mediapipe as mp
import numpy as np
import cmudict


ARPABET_TO_VISEME = {
    "P": "PP", "B": "PP", "M": "PP",
    "F": "FF", "V": "FF",
    "TH": "TH", "DH": "TH",
    "T": "DD", "D": "DD", "N": "DD", "L": "DD",
    "K": "kk", "G": "kk", "NG": "kk", "HH": "kk",
    "CH": "CH", "JH": "CH", "SH": "CH", "ZH": "CH",
    "S": "SS", "Z": "SS",
    "R": "RR", "ER": "RR",
    "AA": "aa", "AE": "aa", "AH": "aa", "AW": "aa", "AY": "aa",
    "EH": "E", "EY": "E",
    "IH": "ih", "IY": "ih",
    "AO": "oh", "OW": "oh", "OY": "oh",
    "UH": "ou", "UW": "ou", "W": "ou",
    "Y": "ih",
}

VISEME_TO_FAMILY = {
    "sil": "closed",
    "PP": "closed",
    "FF": "narrow",
    "TH": "narrow",
    "DD": "narrow",
    "kk": "narrow",
    "CH": "rounded",
    "SS": "narrow",
    "nn": "narrow",
    "RR": "narrow",
    "aa": "open",
    "E": "wide",
    "ih": "wide",
    "oh": "rounded",
    "ou": "rounded",
}

FAMILY_PROTOTYPES = {
    # normalized openness, normalized width
    "closed": (0.03, 0.48),
    "narrow": (0.28, 0.42),
    "wide": (0.43, 0.92),
    "rounded": (0.55, 0.10),
    "open": (0.95, 0.48),
}

VOWELS = {
    "AA", "AE", "AH", "AO", "AW", "AY", "EH", "ER", "EY",
    "IH", "IY", "OW", "OY", "UH", "UW",
}

MOUTH = {
    "left": 61,
    "right": 291,
    "inner_top": 13,
    "inner_bottom": 14,
    "outer_top": 0,
    "outer_bottom": 17,
    "face_left": 234,
    "face_right": 454,
}


def strip_stress(phone):
    return re.sub(r"\d+$", "", str(phone).upper())


def clean_word(value):
    return re.sub(r"[^a-z']", "", str(value).lower().replace("’", "'"))


def grapheme_fallback(word):
    """Small English fallback for words missing from CMUdict."""
    token = clean_word(word)
    result = []
    index = 0
    digraphs = {
        "th": "TH", "sh": "SH", "ch": "CH", "ph": "F",
        "ng": "NG", "wh": "W", "oo": "UW", "ee": "IY",
        "ow": "OW", "ou": "AW", "oi": "OY", "oy": "OY",
    }
    singles = {
        "a": "AE", "b": "B", "c": "K", "d": "D", "e": "EH",
        "f": "F", "g": "G", "h": "HH", "i": "IH", "j": "JH",
        "k": "K", "l": "L", "m": "M", "n": "N", "o": "AO",
        "p": "P", "q": "K", "r": "R", "s": "S", "t": "T",
        "u": "UH", "v": "V", "w": "W", "x": "K", "y": "Y", "z": "Z",
    }

    while index < len(token):
        pair = token[index:index + 2]
        if pair in digraphs:
            result.append(digraphs[pair])
            index += 2
            continue
        if token[index] in singles:
            result.append(singles[token[index]])
        index += 1

    return result or ["AH"]


def pronunciation_dictionary():
    raw = cmudict.dict()
    return {
        key.lower(): [strip_stress(phone) for phone in pronunciations[0]]
        for key, pronunciations in raw.items()
        if pronunciations
    }


def phones_for_word(word, dictionary):
    token = clean_word(word)
    if not token:
        return []
    return dictionary.get(token) or grapheme_fallback(token)


def phone_weight(phone):
    return 1.35 if phone in VOWELS else 1.0


def build_expected_segments(words, duration=None):
    dictionary = pronunciation_dictionary()
    segments = []
    previous_end = 0.0

    for item in words:
        word = str(item.get("word", "")).strip()
        start = max(0.0, float(item.get("start", 0.0) or 0.0))
        end = max(start, float(item.get("end", start) or start))

        if start - previous_end >= 0.18:
            segments.append({
                "phoneme": "SIL",
                "viseme": "sil",
                "family": "closed",
                "start": previous_end,
                "end": start,
            })

        phones = phones_for_word(word, dictionary)
        if not phones:
            previous_end = end
            continue

        weights = [phone_weight(phone) for phone in phones]
        total_weight = sum(weights) or len(phones)
        cursor = start
        span = max(0.04, end - start)

        for index, phone in enumerate(phones):
            fraction = weights[index] / total_weight
            phone_end = end if index == len(phones) - 1 else cursor + span * fraction
            normalized_phone = strip_stress(phone)
            viseme = ARPABET_TO_VISEME.get(normalized_phone, "DD")
            segments.append({
                "phoneme": normalized_phone,
                "viseme": viseme,
                "family": VISEME_TO_FAMILY.get(viseme, "narrow"),
                "start": cursor,
                "end": max(cursor + 0.02, phone_end),
            })
            cursor = phone_end

        previous_end = end

    total_duration = float(duration or previous_end or 0.0)
    if total_duration - previous_end >= 0.18:
        segments.append({
            "phoneme": "SIL",
            "viseme": "sil",
            "family": "closed",
            "start": previous_end,
            "end": total_duration,
        })

    return segments


def distance(a, b):
    return math.dist((a.x, a.y), (b.x, b.y))


def mouth_features(landmarks):
    mouth_width = max(1e-6, distance(landmarks[MOUTH["left"]], landmarks[MOUTH["right"]]))
    face_width = max(1e-6, distance(landmarks[MOUTH["face_left"]], landmarks[MOUTH["face_right"]]))
    inner_open = distance(landmarks[MOUTH["inner_top"]], landmarks[MOUTH["inner_bottom"]])
    outer_open = distance(landmarks[MOUTH["outer_top"]], landmarks[MOUTH["outer_bottom"]])

    return {
        "inner_open_ratio": inner_open / mouth_width,
        "outer_open_ratio": outer_open / mouth_width,
        "width_face_ratio": mouth_width / face_width,
    }


def percentile(values, q):
    if not values:
        return 0.0
    return float(np.percentile(np.asarray(values, dtype=np.float32), q))


def normalize_feature(value, low, high):
    if high - low < 1e-6:
        return 0.5
    return float(np.clip((value - low) / (high - low), 0.0, 1.0))


def softmax_scores(open_value, width_value):
    sigma = 0.33
    raw = {}
    for family, (target_open, target_width) in FAMILY_PROTOTYPES.items():
        squared = (open_value - target_open) ** 2 + (width_value - target_width) ** 2
        raw[family] = math.exp(-squared / (2 * sigma * sigma))

    total = sum(raw.values()) or 1.0
    return {family: score / total for family, score in raw.items()}


def sample_video(video_path, segments):
    capture = cv2.VideoCapture(video_path)
    if not capture.isOpened():
        raise RuntimeError(f"Unable to open video: {video_path}")

    face_mesh = mp.solutions.face_mesh.FaceMesh(
        static_image_mode=True,
        max_num_faces=1,
        refine_landmarks=True,
        min_detection_confidence=0.5,
    )

    samples = []
    try:
        for index, segment in enumerate(segments):
            timestamp = (float(segment["start"]) + float(segment["end"])) / 2.0
            capture.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = capture.read()
            if not ok or frame is None:
                samples.append({
                    **segment,
                    "index": index,
                    "timestamp": timestamp,
                    "face": False,
                })
                continue

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            result = face_mesh.process(rgb)
            if not result.multi_face_landmarks:
                samples.append({
                    **segment,
                    "index": index,
                    "timestamp": timestamp,
                    "face": False,
                })
                continue

            landmarks = result.multi_face_landmarks[0].landmark
            samples.append({
                **segment,
                "index": index,
                "timestamp": timestamp,
                "face": True,
                "features": mouth_features(landmarks),
            })
    finally:
        face_mesh.close()
        capture.release()

    return samples


def classify_samples(samples):
    usable = [sample for sample in samples if sample.get("face") and sample.get("features")]
    if not usable:
        return samples

    openings = [sample["features"]["inner_open_ratio"] for sample in usable]
    widths = [sample["features"]["width_face_ratio"] for sample in usable]

    open_low = percentile(openings, 10)
    open_high = percentile(openings, 90)
    width_low = percentile(widths, 10)
    width_high = percentile(widths, 90)

    for sample in usable:
        features = sample["features"]
        open_norm = normalize_feature(features["inner_open_ratio"], open_low, open_high)
        width_norm = normalize_feature(features["width_face_ratio"], width_low, width_high)
        probabilities = softmax_scores(open_norm, width_norm)
        observed = max(probabilities, key=probabilities.get)
        sample["normalized"] = {
            "openness": open_norm,
            "width": width_norm,
        }
        sample["probabilities"] = probabilities
        sample["observedFamily"] = observed
        sample["confidence"] = probabilities[observed]

    return samples


def aggregate(samples):
    total_weight = 0.0
    covered_weight = 0.0
    probability_weighted = 0.0
    exact_weighted = 0.0
    total_phonemes = 0
    evaluated_phonemes = 0
    family_total = Counter()
    family_correct = Counter()
    confusion = Counter()
    mismatches = []

    for sample in samples:
        duration = max(0.02, float(sample["end"]) - float(sample["start"]))
        total_weight += duration
        total_phonemes += 1
        family_total[sample["family"]] += 1

        if not sample.get("face") or "probabilities" not in sample:
            mismatches.append({
                "start": sample["start"],
                "end": sample["end"],
                "phoneme": sample["phoneme"],
                "viseme": sample["viseme"],
                "expectedFamily": sample["family"],
                "observedFamily": "missing-face",
                "confidence": 0.0,
            })
            continue

        covered_weight += duration
        evaluated_phonemes += 1
        expected = sample["family"]
        observed = sample["observedFamily"]
        expected_probability = float(sample["probabilities"].get(expected, 0.0))
        probability_weighted += expected_probability * duration

        exact = 1.0 if observed == expected else 0.0
        exact_weighted += exact * duration
        if exact:
            family_correct[expected] += 1
        confusion[f"{expected}->{observed}"] += 1

        if not exact or expected_probability < 0.45:
            mismatches.append({
                "start": sample["start"],
                "end": sample["end"],
                "phoneme": sample["phoneme"],
                "viseme": sample["viseme"],
                "expectedFamily": expected,
                "observedFamily": observed,
                "confidence": expected_probability,
            })

    coverage = covered_weight / total_weight if total_weight else 0.0
    phoneme_alignment = probability_weighted / covered_weight if covered_weight else 0.0
    viseme_alignment = exact_weighted / covered_weight if covered_weight else 0.0

    family_accuracy = {}
    for family, count in family_total.items():
        family_accuracy[family] = (
            family_correct[family] / count if count else 0.0
        )

    mismatches.sort(key=lambda item: item["confidence"])

    return {
        "phonemeAlignmentScore": round(phoneme_alignment, 4),
        "visemeAlignmentScore": round(viseme_alignment, 4),
        "coverage": round(coverage, 4),
        "evaluatedPhonemes": evaluated_phonemes,
        "totalPhonemes": total_phonemes,
        "familyAccuracy": {
            key: round(value, 4)
            for key, value in family_accuracy.items()
        },
        "confusion": dict(confusion),
        "worstMismatches": mismatches[:12],
        "evaluator": {
            "name": "tiktokmoney-mouth-landmark-viseme-v1",
            "version": "1",
            "mode": "phoneme-viseme-landmark",
        },
        "limitation": (
            "MediaPipe mouth-landmark geometry classifier. ARPAbet phonemes are "
            "mapped to the Meta/Oculus viseme inventory and then merged into "
            "visually distinguishable macro-viseme families. Within-word phoneme "
            "timing is distributed across independently transcribed word spans."
        ),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--transcription-json", required=True)
    args = parser.parse_args()

    try:
        transcription = json.loads(args.transcription_json)
        words = transcription.get("words") or []
        if not words:
            raise RuntimeError("Transcription contains no word timestamps")

        segments = build_expected_segments(
            words,
            duration=transcription.get("duration"),
        )
        if not segments:
            raise RuntimeError("Could not derive any expected phoneme segments")

        samples = classify_samples(sample_video(args.video, segments))
        print(json.dumps(aggregate(samples)))
    except Exception as exc:
        print(json.dumps({
            "error": str(exc),
            "evaluator": {
                "name": "tiktokmoney-mouth-landmark-viseme-v1",
                "version": "1",
                "mode": "phoneme-viseme-landmark",
            },
        }))
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
