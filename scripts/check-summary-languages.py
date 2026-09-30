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
from summaries.summary_language import INPUT_MIN_LANGUAGE_SHARE, LANGUAGE_POLICY_VERSION, build_language_check_prompt, detected_language_code, SummaryLanguageError
from summaries.summary_pipeline import extract_json_object

parser = argparse.ArgumentParser()
parser.add_argument("--runtime-dir", required=True)
parser.add_argument("--model-path", required=True)
parser.add_argument("--output", required=True)
parser.add_argument("--paths-only", action="store_true", help="Check chunk/merge/repair paths instead of the retained-language fixtures")
parser.add_argument("--review-only", action="store_true", help="Bounded neighboring, predominant and short-language controls")
parser.add_argument("--long-only", action="store_true", help="One non-English chunk near the existing estimated budget; no context tuning")
parser.add_argument("--controls-only", action="store_true", help="Recheck retained input-language controls without regenerating summaries")
parser.add_argument("--case", help="Run one named review case (requires --review-only)")
args = parser.parse_args()
if sum((args.paths_only, args.review_only, args.long_only, args.controls_only)) > 1:
    parser.error("Choose only one check mode")
if args.case and not args.review_only:
    parser.error("--case requires --review-only")
for key in ("HF_TOKEN", "HUGGINGFACE_HUB_TOKEN", "HUGGING_FACE_HUB_TOKEN"):
    os.environ.pop(key, None)
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_TOKEN_PATH=os.devnull)
runtime = resolve_llama_runtime(runtime_dir=args.runtime_dir, model_path=args.model_path)
fixtures_path = Path(__file__).resolve().parents[1] / "tests/manual/summary-language-fixtures.json"
fixtures = json.loads(fixtures_path.read_text(encoding="utf-8"))
review_path = fixtures_path.with_name("summary-language-review-fixtures.json")
review = json.loads(review_path.read_text(encoding="utf-8"))
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
results = {"languagePolicyVersion": LANGUAGE_POLICY_VERSION,
           "fixtureSha256": hashlib.sha256(fixtures_path.read_bytes()).hexdigest(), "checks": {}}

def run_prompt(rt, path, tokens):
    result = run_llama_prompt(rt, prompt_path=path, max_tokens=tokens)
    if args.review_only and "language.prompt" in path:
        print(f"Classifier {Path(path).name}: {json.dumps(extract_json_object(result), ensure_ascii=True)}", flush=True)
    return result

results["paths"] = {}
if args.long_only:
    from summaries.summary_runner import resolve_chunk_token_budget
    from summaries.summary_pipeline import chunk_transcript, get_summary_profile
    budget = resolve_chunk_token_budget(runtime, get_summary_profile("concise"))
    # Repeated public Chinese speech, bounded just below the existing heuristic
    # budget. This probes overflow only; repetition is not useful-quality evidence.
    segments = []
    while True:
        candidate = segments + [{"text": fixtures["zh"]}]
        chunks = chunk_transcript(candidate, max_tokens=budget)
        if len(chunks) != 1 or chunks[0]["estimatedTokens"] > budget * .99:
            break
        segments = candidate
    chunks = chunk_transcript(segments, max_tokens=budget)
    try:
        summary = generate_summary_from_segments(meeting_id="synthetic-long-zh", segments=segments,
            runtime=runtime, profile="concise", language="zh", run_prompt=run_prompt)
        results["paths"]["long-zh"] = {"pass": True, "summary": summary}
    except Exception as exc:
        results["paths"]["long-zh"] = {"pass": False, "error": str(exc)}
    results["budget"] = budget
    results["estimatedTokens"] = chunks[0]["estimatedTokens"]
    results["characters"] = len(chunks[0]["text"])
    (output / "long.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(results, ensure_ascii=False), flush=True)
    sys.exit(0 if results["paths"]["long-zh"]["pass"] else 1)

if args.review_only:
    results["reviewFixtureSha256"] = hashlib.sha256(review_path.read_bytes()).hexdigest()
    controls = {**review["neighbors"], **review["predominant"],
                "shortAboveFloor": review["shortAboveFloor"], "balanced": fixtures["en"] + "\n" + fixtures["es"]}
    generations = [(f"short-{language}", language, prose) for language, prose in review["shortMeetings"].items()]
    generations += [(f"predominant-{language}", language, prose) for language, prose in review["predominant"].items()]
    if args.case and args.case not in controls and args.case not in {case_id for case_id, _, _ in generations}:
        parser.error("Unknown review case")
    for case_id, prose in controls.items():
        if args.case and args.case != case_id:
            continue
        path = output / "control.prompt.txt"
        path.write_text(build_language_check_prompt(prose, transcript=True), encoding="utf-8")
        result = extract_json_object(run_prompt(runtime, str(path), 96))
        results["checks"][case_id] = result
        print(f"Control {case_id}: {result}", flush=True)
        (output / "review.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    def valid_control(case_id, result):
        if case_id == "balanced":
            return result.get("certain") is False or isinstance(result.get("share"), (int, float)) and result["share"] < INPUT_MIN_LANGUAGE_SHARE
        if case_id == "shortAboveFloor":
            return result.get("language") == "unknown" and result.get("certain") is False
        return detected_language_code(result.get("language")) == case_id and result.get("certain") is True and result.get("share", 0) >= INPUT_MIN_LANGUAGE_SHARE
    valid_controls = all(valid_control(case_id, result) for case_id, result in results["checks"].items())
    for case_id, language, prose in generations:
        if args.case and args.case != case_id:
            continue
        try:
            summary = generate_summary_from_segments(meeting_id=case_id, segments=[{"text": prose}],
                runtime=runtime, profile="concise", language=language, run_prompt=run_prompt)
            results["paths"][case_id] = {"pass": True, "summary": summary}
        except Exception as exc:
            results["paths"][case_id] = {"pass": False, "error": str(exc)}
        print(f"Generation {case_id}: {results['paths'][case_id]['pass']}", flush=True)
        (output / "review.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0 if valid_controls and all(item["pass"] for item in results["paths"].values()) else 1)

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
                    return json.dumps({"summary": review["denials"][language]}, ensure_ascii=False)
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
    if args.controls_only:
        break
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
    path.write_text(build_language_check_prompt(prose, transcript=True), encoding="utf-8")
    try:
        results["detector"][fixture_id] = extract_json_object(run_prompt(runtime, str(path), 96))
    except Exception as exc:
        results["detector"][fixture_id] = {"error": str(exc)}
    print(f"Control {fixture_id}: {results['detector'][fixture_id]}", flush=True)
    (output / "results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

sys.exit(0 if all(item["pass"] for item in results["checks"].values()) and all(
    (detected_language_code(result.get("language")) == fixture_id.split("-")[0] and result.get("certain") is True and result.get("share", 0) >= INPUT_MIN_LANGUAGE_SHARE)
    if fixture_id in fixtures else (result.get("certain") is False or result.get("share", 1) < INPUT_MIN_LANGUAGE_SHARE)
    for fixture_id, result in results["detector"].items()
) else 1)
