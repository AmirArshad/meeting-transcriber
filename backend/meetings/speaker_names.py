"""Validation and stable hashing for non-destructive speaker name overlays."""

import hashlib
import json
import re
import unicodedata

_SPEAKER_ID = re.compile(r'(?:Speaker (?:[1-9]|[1-9][0-9])|SPEAKER_[0-9]{2})\Z')


def normalize_speaker_names(value, *, strict=False):
    if not isinstance(value, dict):
        if strict:
            raise ValueError('Speaker names must be an object')
        return {}
    result = {}
    for key, name in value.items():
        if not isinstance(key, str) or not _SPEAKER_ID.fullmatch(key) or not isinstance(name, str):
            if strict:
                raise ValueError('Invalid speaker name entry')
            continue
        clean = ''.join(
            char for char in name
            if char != '*' and not unicodedata.category(char).startswith('C')
            and unicodedata.category(char) not in ('Zl', 'Zp')
        )
        while '-->' in clean:
            clean = clean.replace('-->', '')
        clean = clean.strip()[:64].strip()
        result[key] = clean
    return result


def speaker_names_hash(names):
    normalized = {key: name for key, name in normalize_speaker_names(names).items() if name}
    if not normalized:
        return ''
    data = json.dumps(normalized, sort_keys=True, ensure_ascii=False).encode('utf-8')
    return 'sha256:' + hashlib.sha256(data).hexdigest()
