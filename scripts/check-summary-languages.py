"""Explicit offline synthetic check against an already installed summary model.

No downloads or meeting data. Reports stay at the caller's output path.
Run only when the app's compute is idle. This is bounded language evidence,
not a platform, memory, performance or general quality benchmark.
"""
import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from summaries.llama_runtime import resolve_llama_runtime, run_llama_prompt
from summaries.summary_runner import generate_summary_from_segments, generate_summary, hash_transcript_text
from summaries.summary_language import build_language_check_prompt, SummaryLanguageError
from summaries.summary_pipeline import extract_json_object

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-dir", required=True)
parser.add_argument("--model-path", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--paths-only", action="store_true", help="Check chunk/merge/repair paths instead of the retained-language fixtures")
args = parser.parse_args()
for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
    os.environ.pop(key, None)
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_TOKEN_PATH=os.devnull)
runtime = resolve_llama_runtime(runtime_dir=args.runtime_dir, model_path=args.model_path)
fixtures_path = Path(__file__).resolve().parents[1] / "tests/manual/summary-language-fixtures.json"
fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
results = {"fixtureSha256": hashlib.sha256(fixtures_path.read_bytes()).hexdigest(), "checks": {}}

def run_prompt(rt, path, tokens):
    return run_llama_prompt(rt, prompt_path=path, max_tokens=tokens)

results["paths"] = {}
if args.paths_only:
    import summaries.summary_runner as runner
    # Force a genuine two-chunk path using short fixtures, with the ordinary
    # installed context/CLI unchanged. This is not a context/performance study.
    original_budget = runner.resolve_chunk_token_budget
    cases = [
        ("es-merge", "es", "concise", "merge"),
        ("fr-detailed", "fr", "detailed", None),
        ("ja-actions", "ja", "action-items", None),
        ("es-json-repair", "es", "balanced", "malformed"),
        ("de-grounded-retry", "de", "balanced", "denial"),
        ("es-language-retry", "es", "balanced", "wrong-language"),
    ]
    for case_id, language, profile, fault in cases:
        calls = []
        injected = False
        def probe_prompt(rt, path, tokens):
            global injected
            calls.append(Path(path).name)
            if not injected and "language.prompt" not in path:
                injected = True
                if fault == "malformed":
                    return "{invalid JSON"
                if fault == "denial":
                    return '{"summary":"No meeting content was provided."}'
                if fault == "wrong-language":
                    return json.dumps({"summary": fixtures["en"]})
            return run_prompt(rt, path, tokens)
        print(f"Checking path {case_id}", flush=True)
        try:
            runner.resolve_chunk_token_budget = (lambda *_: 80) if fault == "merge" else original_budget
            summary = generate_summary_from_segments(
                meeting_id=f"synthetic-{case_id}",
                segments=[{"start": i * 60, "end": (i + 1) * 60, "speaker": "Speaker 1", "text": fixtures[language]} for i in range(2 if fault == "merge" else 1)],
                runtime=runtime, profile=profile, language=language, run_prompt=probe_prompt,
            )
            results["paths"][case_id] = {"pass": True, "calls": calls, "summary": summary}
        except Exception as exc:
            results["paths"][case_id] = {"pass": False, "calls": calls, "error": str(exc)}
        finally:
            runner.resolve_chunk_token_budget = original_budget
        (output / "paths.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    for case_id, text in [("wrong-confirmation", fixtures["en"]), ("balanced-mixed", fixtures["en"] + "\n" + fixtures["es"])]:
        try:
            generate_summary_from_segments(meeting_id=case_id, segments=[{"text": text}], runtime=runtime, language="es", run_prompt=run_prompt)
            results["paths"][case_id] = {"pass": False, "error": "Unexpected acceptance"}
        except SummaryLanguageError:
            results["paths"][case_id] = {"pass": True, "rejected": True}

    transcript = output / "synthetic-es.md"
    transcript.write_text("**[00:00 - 01:00]**\n" + fixtures["es"], encoding="utf-8")
    result = generate_summary(
        meeting_id="synthetic-es-sidecar", transcript_path=str(transcript),
        runtime_dir=args.runtime_dir, model_path=args.model_path,
        language="es", source_transcript_hash=hash_transcript_text(transcript.read_text(encoding="utf-8")),
        model_id="qwen3.5-9b-q4-k-m", profile="balanced",
    )
    results["paths"]["es-sidecars"] = {"pass": result["metadata"]["language"] == "es", "metadata": result["metadata"]}
    (output / "paths.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0 if all(item["pass"] for item in results["paths"].values()) else 1)

for fixture_id, text in fixtures.items():
    language = fixture_id.split("-")[0]
    print(f"Checking {fixture_id}", flush=True)
    try:
        summary = generate_summary_from_segments(
            meeting_id=f"synthetic-{fixture_id}",
            segments=[{"start": 0, "end": 60, "speaker": "Speaker 1", "text": text}],
            runtime=runtime, profile="balanced", language=language, run_prompt=run_prompt,
        )
        results["checks"][fixture_id] = {"pass": True, "summary": summary}
    except Exception as exc:
        results["checks"][fixture_id] = {"pass": False, "error": str(exc)}
    (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")


controls = {**fixtures, "short": "Mira Friday pilot", "mixed": fixtures["en"] + "\n" + fixtures["es"]}
results["detector"] = {}
for fixture_id, prose in controls.items():
    path = output / "control.prompt.txt"
    path.write_text(build_language_check_prompt(prose), encoding="utf-8")
    try:
        results["detector"][fixture_id] = extract_json_object(run_prompt(runtime, str(path), 96))
    except Exception as exc:
        results["detector"][fixture_id] = {"error": str(exc)}
    print(f"Control {fixture_id}: {results['detector'][fixture_id]}", flush=True)
    (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

sys.exit(0 if all(item["pass"] for item in results["checks"].values()) and all(
    result.get("language") == (fixture_id.split("-")[0] if fixture_id in fixtures else "unknown")
    and result.get("certain") is (fixture_id in fixtures)
    for fixture_id, result in results["detector"].items()
) else 1)
