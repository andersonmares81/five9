import argparse
import json
import os
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--model", default=os.getenv("FASTER_WHISPER_MODEL", "small"))
    parser.add_argument("--device", default=os.getenv("FASTER_WHISPER_DEVICE", "cpu"))
    parser.add_argument("--compute-type", dest="compute_type", default=os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8"))
    parser.add_argument("--language", default=os.getenv("FASTER_WHISPER_LANGUAGE", ""))
    parser.add_argument("--vad-filter", default="true")
    args = parser.parse_args()

    from faster_whisper import WhisperModel  # type: ignore

    language = args.language.strip() or None
    vad_filter = str(args.vad_filter).lower() not in ("0", "false", "no", "off", "")

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(
        args.file,
        language=language,
        vad_filter=vad_filter,
        beam_size=5,
    )

    text_parts = []
    out_segments = []
    for seg in segments:
        text_parts.append(seg.text or "")
        out_segments.append(
            {
                "id": getattr(seg, "id", None),
                "start": getattr(seg, "start", None),
                "end": getattr(seg, "end", None),
                "text": seg.text,
            }
        )

    out = {
        "text": "".join(text_parts).strip(),
        "segments": out_segments,
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
        "duration_ms": int(getattr(info, "duration", 0) * 1000) if getattr(info, "duration", None) else None,
    }

    sys.stdout.write(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

