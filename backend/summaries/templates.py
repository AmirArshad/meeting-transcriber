"""Per-tag summary template registry, schema builders, and prompt specs."""

from __future__ import annotations

import json
from typing import Any, Dict, Optional

from meetings.normalization import normalize_recording_tag

TEMPLATE_VERSION = "tag-templates-v1"
SCHEMA_PLACEHOLDER_SUMMARY = "short grounded overview"


def _field(
    *,
    example: Dict[str, Any],
    prose_keys: tuple[str, ...],
    text_keys: tuple[str, ...],
    detail_key: Optional[str] = None,
    metadata_keys: tuple[str, ...] = ("timestamp",),
) -> Dict[str, Any]:
    aliases = {"statement": ("goal", "problem"), "step": ("task", "action"), "task": ("action", "step")}
    extra = aliases.get(text_keys[0], ()) + ("title", "point")
    text_keys = tuple(dict.fromkeys((*text_keys, *extra)))
    prose_keys = tuple(dict.fromkeys((*prose_keys, *extra)))
    return {
        "schema_example": example,
        "prose_keys": prose_keys,
        "text_keys": text_keys,
        "detail_key": detail_key,
        "metadata_keys": metadata_keys,
    }


SUMMARY_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "meeting": {
        "template_id": "meeting",
        "persona": "You are AvaNevis, a local-only meeting summarizer. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only meeting summarizer. Merge these chunk summaries into one final meeting summary.",
        "repair_persona": "You are AvaNevis, a local-only meeting summarizer. The previous response was not valid summary JSON.",
        "content_noun": "meeting",
        "array_fields": ("topics", "decisions", "action_items", "risks", "open_questions"),
        "field_schemas": {
            "topics": _field(
                example={"title": "topic", "summary": "what was discussed", "timestamps": ["MM:SS"]},
                prose_keys=("title", "summary"),
                text_keys=("title", "topic"),
                detail_key="summary",
                metadata_keys=("timestamps",),
            ),
            "decisions": _field(
                example={"decision": "decision made", "owner": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("decision",),
                text_keys=("decision",),
                metadata_keys=("owner", "timestamp"),
            ),
            "action_items": _field(
                example={"task": "task", "owner": "Speaker or Unknown", "due": "date or null", "timestamp": "MM:SS"},
                prose_keys=("task",),
                text_keys=("task", "action"),
                metadata_keys=("owner", "due", "timestamp"),
            ),
            "risks": _field(
                example={"risk": "risk or blocker", "timestamp": "MM:SS"},
                prose_keys=("risk",),
                text_keys=("risk",),
                metadata_keys=("timestamp",),
            ),
            "open_questions": _field(
                example={"question": "question", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "The transcript chunk below is the only meeting content. Summarize that speech.",
        "merge_instructions": "Synthesize all topics, decisions, action items, risks, and open questions cleanly without duplicating identical items.",
        "empty_section_policy": "show_empty",
        "action_style_hint": "Prioritize tasks, owners, due dates, blockers, decisions, and follow-up questions in action_items and decisions.",
        "schema_footer": 'Use only evidence from the transcript. If an owner is not explicit, use "Unknown". Do not include markdown.',
    },
    "appointment": {
        "template_id": "appointment",
        "persona": "You are AvaNevis, a local-only consultation and appointment note assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only consultation and appointment note assistant. Merge these chunk summaries into one final appointment summary.",
        "repair_persona": "You are AvaNevis, a local-only consultation and appointment note assistant. The previous response was not valid summary JSON.",
        "content_noun": "appointment",
        "array_fields": (
            "key_findings",
            "advice_and_guidance",
            "next_steps",
            "instructions_or_prep",
            "questions_to_follow_up",
        ),
        "field_schemas": {
            "key_findings": _field(
                example={"finding": "key finding or observation", "detail": "specific context", "timestamp": "MM:SS"},
                prose_keys=("finding", "detail"),
                text_keys=("finding",),
                detail_key="detail",
                metadata_keys=("timestamp",),
            ),
            "advice_and_guidance": _field(
                example={"guidance": "recommendation or guidance", "rationale": "reason explained", "timestamp": "MM:SS"},
                prose_keys=("guidance", "rationale"),
                text_keys=("guidance",),
                detail_key="rationale",
                metadata_keys=("timestamp",),
            ),
            "next_steps": _field(
                example={"step": "next step", "due": "date or null", "timestamp": "MM:SS"},
                prose_keys=("step",),
                text_keys=("step",),
                metadata_keys=("due", "timestamp"),
            ),
            "instructions_or_prep": _field(
                example={"instruction": "preparation or care instruction", "timestamp": "MM:SS"},
                prose_keys=("instruction",),
                text_keys=("instruction",),
                metadata_keys=("timestamp",),
            ),
            "questions_to_follow_up": _field(
                example={"question": "follow-up question", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Capture findings, professional advice, preparation instructions, due dates, and follow-up questions strictly from the appointment transcript.",
        "merge_instructions": "Consolidate findings, guidance, next steps, prep instructions, and follow-up questions accurately without inventing clinical or legal details.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize concrete next_steps (with due dates) and instructions_or_prep items.",
        "schema_footer": "Use only evidence from the transcript. Leave optional arrays empty when nothing is mentioned. Do not include markdown.",
    },
    "call": {
        "template_id": "call",
        "persona": "You are AvaNevis, a local-only phone and support call note assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only phone and support call note assistant. Merge these chunk summaries into one final call summary.",
        "repair_persona": "You are AvaNevis, a local-only phone and support call note assistant. The previous response was not valid summary JSON.",
        "content_noun": "call",
        "array_fields": ("call_details", "outcomes_and_commitments", "next_steps", "unresolved_issues"),
        "field_schemas": {
            "call_details": _field(
                example={"item": "reference, ticket ID, date, or amount", "value": "exact detail spoken", "timestamp": "MM:SS"},
                prose_keys=("item", "value"),
                text_keys=("item",),
                detail_key="value",
                metadata_keys=("timestamp",),
            ),
            "outcomes_and_commitments": _field(
                example={"commitment": "agreed outcome or promise", "party": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("commitment",),
                text_keys=("commitment",),
                metadata_keys=("party", "timestamp"),
            ),
            "next_steps": _field(
                example={"step": "follow-up step", "owner": "Speaker or Unknown", "due": "date or null", "timestamp": "MM:SS"},
                prose_keys=("step",),
                text_keys=("step",),
                metadata_keys=("owner", "due", "timestamp"),
            ),
            "unresolved_issues": _field(
                example={"issue": "open issue or blocker", "timestamp": "MM:SS"},
                prose_keys=("issue",),
                text_keys=("issue",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Capture exact reference numbers, ticket IDs, dates, prices/amounts, party commitments, next steps, and unresolved issues from the call transcript.",
        "merge_instructions": "Preserve exact reference numbers, amounts, commitments, next steps, and unresolved issues across chunks.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize next_steps, outcomes_and_commitments, and unresolved_issues with responsible parties and deadlines.",
        "schema_footer": 'Use only evidence from the transcript. Never fabricate IDs, amounts, or dates. If a party or owner is unclear, use "Unknown". Do not include markdown.',
    },
    "interview": {
        "template_id": "interview",
        "persona": "You are AvaNevis, a local-only interview notes assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only interview notes assistant. Merge these chunk summaries into one final interview summary.",
        "repair_persona": "You are AvaNevis, a local-only interview notes assistant. The previous response was not valid summary JSON.",
        "content_noun": "interview",
        "array_fields": (
            "background_and_themes",
            "key_qa",
            "notable_quotes",
            "signals_and_highlights",
            "follow_up_questions",
        ),
        "field_schemas": {
            "background_and_themes": _field(
                example={"theme": "recurring theme", "summary": "context covered", "timestamps": ["MM:SS"]},
                prose_keys=("theme", "summary"),
                text_keys=("theme",),
                detail_key="summary",
                metadata_keys=("timestamps",),
            ),
            "key_qa": _field(
                example={"question": "question asked", "answer_summary": "concise summary of the answer", "timestamp": "MM:SS"},
                prose_keys=("question", "answer_summary"),
                text_keys=("question",),
                detail_key="answer_summary",
                metadata_keys=("timestamp",),
            ),
            "notable_quotes": _field(
                example={"quote": "direct or faithful quote", "speaker": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("quote",),
                text_keys=("quote",),
                metadata_keys=("speaker", "timestamp"),
            ),
            "signals_and_highlights": _field(
                example={"point": "notable signal, strength, or concern", "kind": "signal type", "timestamp": "MM:SS"},
                prose_keys=("point",),
                text_keys=("point",),
                metadata_keys=("kind", "timestamp"),
            ),
            "follow_up_questions": _field(
                example={"question": "open follow-up question", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Summarize themes, key Q&A pairs, faithful notable quotes, signals/highlights, and follow-up questions strictly from the interview transcript.",
        "merge_instructions": "Combine recurring themes, key Q&A, quotes, signals, and follow-up questions cleanly across chunks.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize follow_up_questions and concrete signals_and_highlights.",
        "schema_footer": 'Use only evidence from the transcript. Do not fabricate quotes. If a speaker is not explicit, use "Unknown". Do not include markdown.',
    },
    "lecture": {
        "template_id": "lecture",
        "persona": "You are AvaNevis, a local-only lecture and study notes assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only lecture and study notes assistant. Merge these chunk summaries into one final study summary.",
        "repair_persona": "You are AvaNevis, a local-only lecture and study notes assistant. The previous response was not valid summary JSON.",
        "content_noun": "lecture",
        "array_fields": ("core_concepts", "examples_and_cases", "key_takeaways", "study_questions"),
        "field_schemas": {
            "core_concepts": _field(
                example={"concept": "concept or theorem", "explanation": "how it was explained", "timestamps": ["MM:SS"]},
                prose_keys=("concept", "explanation"),
                text_keys=("concept",),
                detail_key="explanation",
                metadata_keys=("timestamps",),
            ),
            "examples_and_cases": _field(
                example={"example": "example or case study", "takeaway": "what it illustrates", "timestamp": "MM:SS"},
                prose_keys=("example", "takeaway"),
                text_keys=("example",),
                detail_key="takeaway",
                metadata_keys=("timestamp",),
            ),
            "key_takeaways": _field(
                example={"takeaway": "main takeaway", "timestamp": "MM:SS"},
                prose_keys=("takeaway",),
                text_keys=("takeaway",),
                metadata_keys=("timestamp",),
            ),
            "study_questions": _field(
                example={"question": "question or topic to review", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Organize core concepts, examples or case studies, key takeaways, and study/review questions grounded in the lecture transcript.",
        "merge_instructions": "Merge concepts, examples, takeaways, and study questions into coherent study notes.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize key_takeaways and actionable study_questions for review.",
        "schema_footer": "Use only evidence from the transcript. Do not invent outside definitions not stated by the speaker. Do not include markdown.",
    },
    "podcast": {
        "template_id": "podcast",
        "persona": "You are AvaNevis, a local-only podcast and show discussion notes assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only podcast and show discussion notes assistant. Merge these chunk summaries into one final episode summary.",
        "repair_persona": "You are AvaNevis, a local-only podcast and show discussion notes assistant. The previous response was not valid summary JSON.",
        "content_noun": "podcast",
        "array_fields": ("chapters_and_segments", "key_insights", "notable_quotes", "references_mentioned"),
        "field_schemas": {
            "chapters_and_segments": _field(
                example={"title": "segment title", "summary": "what was discussed", "timestamps": ["MM:SS"]},
                prose_keys=("title", "summary"),
                text_keys=("title",),
                detail_key="summary",
                metadata_keys=("timestamps",),
            ),
            "key_insights": _field(
                example={"insight": "key idea or argument", "speaker": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("insight",),
                text_keys=("insight",),
                metadata_keys=("speaker", "timestamp"),
            ),
            "notable_quotes": _field(
                example={"quote": "memorable quote", "speaker": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("quote",),
                text_keys=("quote",),
                metadata_keys=("speaker", "timestamp"),
            ),
            "references_mentioned": _field(
                example={"name": "book, tool, paper, or guest", "context": "how it was referenced", "timestamp": "MM:SS"},
                prose_keys=("name", "context"),
                text_keys=("name",),
                detail_key="context",
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Capture discussion chapters/segments, key insights, notable quotes, and books/tools/references mentioned in the podcast transcript.",
        "merge_instructions": "Combine chapters, insights, quotes, and mentioned references across chunks in chronological flow.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize key_insights and concrete references_mentioned listeners may want to look up.",
        "schema_footer": 'Use only evidence from the transcript. If a speaker is not explicit, use "Unknown". Do not include markdown.',
    },
    "video": {
        "template_id": "video",
        "persona": "You are AvaNevis, a local-only video, talk, and tutorial notes assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only video, talk, and tutorial notes assistant. Merge these chunk summaries into one final video summary.",
        "repair_persona": "You are AvaNevis, a local-only video, talk, and tutorial notes assistant. The previous response was not valid summary JSON.",
        "content_noun": "video",
        "array_fields": ("sections", "key_takeaways", "demos_or_steps", "references_mentioned"),
        "field_schemas": {
            "sections": _field(
                example={"title": "section title", "summary": "what was covered", "timestamps": ["MM:SS"]},
                prose_keys=("title", "summary"),
                text_keys=("title",),
                detail_key="summary",
                metadata_keys=("timestamps",),
            ),
            "key_takeaways": _field(
                example={"takeaway": "main takeaway", "timestamp": "MM:SS"},
                prose_keys=("takeaway",),
                text_keys=("takeaway",),
                metadata_keys=("timestamp",),
            ),
            "demos_or_steps": _field(
                example={"step": "walkthrough step or demo", "detail": "specific commands or actions", "timestamp": "MM:SS"},
                prose_keys=("step", "detail"),
                text_keys=("step",),
                detail_key="detail",
                metadata_keys=("timestamp",),
            ),
            "references_mentioned": _field(
                example={"name": "resource, library, or link mentioned", "context": "how it was used", "timestamp": "MM:SS"},
                prose_keys=("name", "context"),
                text_keys=("name",),
                detail_key="context",
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Capture video sections, key takeaways, concrete walkthrough/demo steps, and references mentioned in the transcript.",
        "merge_instructions": "Merge sections, takeaways, ordered demo steps, and mentioned references cleanly.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize demos_or_steps and key_takeaways.",
        "schema_footer": "Use only evidence from the transcript. Leave optional arrays empty when not present. Do not include markdown.",
    },
    "voice-note": {
        "template_id": "voice-note",
        "persona": "You are AvaNevis, a local-only personal voice memo organizer. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only personal voice memo organizer. Merge these chunk summaries into one final voice note summary.",
        "repair_persona": "You are AvaNevis, a local-only personal voice memo organizer. The previous response was not valid summary JSON.",
        "content_noun": "voice note",
        "array_fields": ("key_thoughts", "ideas", "reminders_and_todos", "open_questions"),
        "field_schemas": {
            "key_thoughts": _field(
                example={"thought": "core thought", "detail": "supporting reflection", "timestamp": "MM:SS"},
                prose_keys=("thought", "detail"),
                text_keys=("thought",),
                detail_key="detail",
                metadata_keys=("timestamp",),
            ),
            "ideas": _field(
                example={"idea": "captured idea", "timestamp": "MM:SS"},
                prose_keys=("idea",),
                text_keys=("idea",),
                metadata_keys=("timestamp",),
            ),
            "reminders_and_todos": _field(
                example={"task": "explicit reminder or to-do", "due": "date or null", "timestamp": "MM:SS"},
                prose_keys=("task",),
                text_keys=("task",),
                metadata_keys=("due", "timestamp"),
            ),
            "open_questions": _field(
                example={"question": "open question to revisit", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Clean up spoken thoughts, ideas, explicit reminders/to-dos, and open questions without inventing formal corporate action items not spoken.",
        "merge_instructions": "Consolidate personal thoughts, ideas, explicit reminders, and open questions cleanly.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize explicit reminders_and_todos (with any stated due dates) and open_questions.",
        "schema_footer": "Use only evidence from the transcript. Never turn casual musings into invented formal tasks. Do not include markdown.",
    },
    "brainstorm": {
        "template_id": "brainstorm",
        "persona": "You are AvaNevis, a local-only creative and planning brainstorm organizer. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only creative and planning brainstorm organizer. Merge these chunk summaries into one final brainstorm summary.",
        "repair_persona": "You are AvaNevis, a local-only creative and planning brainstorm organizer. The previous response was not valid summary JSON.",
        "content_noun": "brainstorm",
        "array_fields": (
            "problem_or_goal",
            "ideas_explored",
            "standout_concepts",
            "tradeoffs_and_concerns",
            "next_experiments",
        ),
        "field_schemas": {
            "problem_or_goal": _field(
                example={"statement": "problem statement or goal", "timestamp": "MM:SS"},
                prose_keys=("statement",),
                text_keys=("statement",),
                metadata_keys=("timestamp",),
            ),
            "ideas_explored": _field(
                example={"idea": "idea pitched", "theme": "theme or category", "timestamp": "MM:SS"},
                prose_keys=("idea",),
                text_keys=("idea",),
                metadata_keys=("theme", "timestamp"),
            ),
            "standout_concepts": _field(
                example={"concept": "promising concept", "why": "why it stood out", "timestamp": "MM:SS"},
                prose_keys=("concept", "why"),
                text_keys=("concept",),
                detail_key="why",
                metadata_keys=("timestamp",),
            ),
            "tradeoffs_and_concerns": _field(
                example={"concern": "tradeoff, constraint, or concern", "timestamp": "MM:SS"},
                prose_keys=("concern",),
                text_keys=("concern",),
                metadata_keys=("timestamp",),
            ),
            "next_experiments": _field(
                example={"experiment": "next prototype or test", "owner": "Speaker or Unknown", "timestamp": "MM:SS"},
                prose_keys=("experiment",),
                text_keys=("experiment",),
                metadata_keys=("owner", "timestamp"),
            ),
        },
        "chunk_instructions": "Capture the problem or goal, ideas explored, standout concepts, tradeoffs/concerns, and next experiments from the brainstorm transcript.",
        "merge_instructions": "Synthesize goals, explored ideas, standout concepts, tradeoffs, and next experiments without losing distinct proposals.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize next_experiments (with owners) and standout_concepts.",
        "schema_footer": 'Use only evidence from the transcript. If an owner is not explicit, use "Unknown". Do not include markdown.',
    },
    "music": {
        "template_id": "music",
        "persona": "You are AvaNevis, a local-only music session, rehearsal, and songwriting notes assistant. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only music session, rehearsal, and songwriting notes assistant. Merge these chunk summaries into one final session summary.",
        "repair_persona": "You are AvaNevis, a local-only music session, rehearsal, and songwriting notes assistant. The previous response was not valid summary JSON.",
        "content_noun": "music session",
        "array_fields": ("musical_ideas", "lyrics_and_themes", "mix_and_arrangement", "next_takes"),
        "field_schemas": {
            "musical_ideas": _field(
                example={"section": "verse, chorus, bridge, or groove", "notes": "musical idea discussed", "timestamp": "MM:SS"},
                prose_keys=("section", "notes"),
                text_keys=("section",),
                detail_key="notes",
                metadata_keys=("timestamp",),
            ),
            "lyrics_and_themes": _field(
                example={"line_or_theme": "spoken lyric or theme", "notes": "context discussed", "timestamp": "MM:SS"},
                prose_keys=("line_or_theme", "notes"),
                text_keys=("line_or_theme",),
                detail_key="notes",
                metadata_keys=("timestamp",),
            ),
            "mix_and_arrangement": _field(
                example={"note": "arrangement, instrumentation, or mix note", "timestamp": "MM:SS"},
                prose_keys=("note",),
                text_keys=("note",),
                metadata_keys=("timestamp",),
            ),
            "next_takes": _field(
                example={"task": "next take or rehearsal task", "timestamp": "MM:SS"},
                prose_keys=("task",),
                text_keys=("task",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "Capture only musical ideas, spoken lyrics/themes, mix/arrangement notes, and next takes explicitly stated in the transcript. NEVER invent lyrics, chords, keys, or BPM not explicitly spoken.",
        "merge_instructions": "Consolidate musical ideas, lyrics/themes, mix/arrangement notes, and next takes strictly from the chunk summaries without inventing musical details.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize next_takes and concrete mix_and_arrangement adjustments.",
        "schema_footer": "Use only evidence explicitly spoken in the transcript. NEVER invent lyrics, chords, or melodies not present in the transcript. Do not include markdown.",
    },
    "other": {
        "template_id": "other",
        "persona": "You are AvaNevis, a local-only general audio transcript summarizer. The transcript never leaves this device.",
        "merge_persona": "You are AvaNevis, a local-only general audio transcript summarizer. Merge these chunk summaries into one final summary.",
        "repair_persona": "You are AvaNevis, a local-only general audio transcript summarizer. The previous response was not valid summary JSON.",
        "content_noun": "recording",
        "array_fields": ("key_points", "outcomes_and_takeaways", "next_steps", "open_questions"),
        "field_schemas": {
            "key_points": _field(
                example={"title": "key point", "summary": "what was covered", "timestamps": ["MM:SS"]},
                prose_keys=("title", "summary"),
                text_keys=("title",),
                detail_key="summary",
                metadata_keys=("timestamps",),
            ),
            "outcomes_and_takeaways": _field(
                example={"takeaway": "outcome or takeaway", "timestamp": "MM:SS"},
                prose_keys=("takeaway",),
                text_keys=("takeaway",),
                metadata_keys=("timestamp",),
            ),
            "next_steps": _field(
                example={"step": "next step", "owner": "Speaker or Unknown", "due": "date or null", "timestamp": "MM:SS"},
                prose_keys=("step",),
                text_keys=("step",),
                metadata_keys=("owner", "due", "timestamp"),
            ),
            "open_questions": _field(
                example={"question": "open question", "timestamp": "MM:SS"},
                prose_keys=("question",),
                text_keys=("question",),
                metadata_keys=("timestamp",),
            ),
        },
        "chunk_instructions": "The transcript chunk below is the only recording content. Summarize the key points, outcomes/takeaways, next steps, and open questions.",
        "merge_instructions": "Combine key points, outcomes/takeaways, next steps, and open questions cleanly across chunks.",
        "empty_section_policy": "omit",
        "action_style_hint": "Emphasize next_steps and outcomes_and_takeaways.",
        "schema_footer": 'Use only evidence from the transcript. If an owner is not explicit, use "Unknown". Do not include markdown.',
    },
}


def resolve_template_id(tag: Optional[str] = None, *, fallback: str = "meeting") -> str:
    """Resolve an optional tag or template ID to a canonical template key."""
    normalized = normalize_recording_tag(tag, strict=False)
    if normalized and normalized in SUMMARY_TEMPLATES:
        return normalized
    if fallback in SUMMARY_TEMPLATES:
        return fallback
    return "meeting"


def get_template(tag: Optional[str] = None, *, fallback: str = "meeting") -> Dict[str, Any]:
    """Return the template specification for ``tag`` (defaulting cleanly)."""
    template_id = resolve_template_id(tag, fallback=fallback)
    return SUMMARY_TEMPLATES[template_id]


def render_schema_instruction(tag: Optional[str] = None, *, fallback: str = "meeting") -> str:
    """Render the strict JSON schema instruction block for ``tag``."""
    template = get_template(tag, fallback=fallback)
    shape: Dict[str, Any] = {"summary": SCHEMA_PLACEHOLDER_SUMMARY}
    for field in template["array_fields"]:
        shape[field] = [template["field_schemas"][field]["schema_example"]]
    lines = ["Return only valid JSON with this exact shape:", "{"]
    items = list(shape.items())
    for index, (key, value) in enumerate(items):
        comma = "," if index < len(items) - 1 else ""
        lines.append(f'  "{key}": {json.dumps(value, ensure_ascii=False)}{comma}')
    lines.append("}")
    lines.append(template["schema_footer"])
    return "\n".join(lines)
