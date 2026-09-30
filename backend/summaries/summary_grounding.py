"""Narrow, deterministic absence-of-transcript guards for retained languages.

These match clear denials, not affirmative mentions of a supplied transcript.
They supplement the established English guard; they are not a general factual
grounding detector or an exhaustive list of every possible denial paraphrase.
"""
import re

DENIAL_PATTERNS = {
    "es": (
        r"\bno se (?:ha )?(?:proporcion[oó]|facilit[oó]|incluy[oó])(?: ninguna| una| la)? (?:transcripci[oó]n|contenido)",
        r"\b(?:transcripci[oó]n|contenido).{0,35}(?:no (?:fue|est[aá]|se ha) (?:proporcionad|disponible)|(?:est[aá]|es) (?:ausente|vac[ií]))",
    ),
    "fr": (
        r"\baucun(?:e)? (?:transcription|contenu).{0,50}(?:fourni|disponible|pr[eé]sent)",
        r"\b(?:transcription|contenu).{0,35}(?:n['’](?:a|est).{0,20}(?:fourni|disponible)|(?:est|[ée]tait) (?:absent|vide))",
    ),
    "de": (
        r"\bkein(?:e|en)? (?:transkript|besprechungsinhalt|sitzungsinhalt).{0,50}(?:bereitgestellt|vorhanden|verf[uü]gbar)",
        r"\b(?:transkript|besprechungsinhalt).{0,35}(?:nicht (?:bereitgestellt|vorhanden|verf[uü]gbar)|(?:ist|war) (?:leer|nicht vorhanden))",
    ),
    "zh": (
        r"(?:未|没有|沒有)(?:提供|包含).{0,12}(?:转录|轉錄|记录|記錄|会议内容|會議內容)",
        r"(?:缺少|缺乏).{0,12}(?:会议|會議)(?:记录|記錄|内容|內容|转录|轉錄)",
        r"(?:会议|會議)(?:记录|記錄|内容|內容|转录|轉錄).{0,12}(?:缺失|为空|為空|不存在)",
    ),
    "ja": (
        r"(?:文字起こし|会議(?:の)?内容|議事録).{0,20}(?:提供されてい(?:ない|ません)|ありません|含まれていない|見つか(?:らない|りません))",
    ),
    "it": (
        r"\bnon [eè] stat[ao] (?:fornita|fornito|inclusa|incluso).{0,20}(?:trascrizione|contenuto)",
        r"\b(?:trascrizione|contenuto).{0,35}(?:non [eè] (?:stat[ao] )?(?:fornit|disponibile)|[eè] (?:assente|vuot))",
    ),
    "pa": (
        r"(?:ਪ੍ਰਤੀਲਿਪੀ|ਮੀਟਿੰਗ ਦੀ ਸਮੱਗਰੀ).{0,30}(?:ਪ੍ਰਦਾਨ ਨਹੀਂ|ਉਪਲਬਧ ਨਹੀਂ|ਮੌਜੂਦ ਨਹੀਂ|ਗਾਇਬ|ਖਾਲੀ)",
        r"(?:نقل|میٹنگ دا متن|میٹنگ دی گل بات).{0,30}(?:فراہم نہیں|موجود نہیں|خالی)",
    ),
    "hi": (
        r"(?:प्रतिलेख|प्रतिलिपि|बैठक की सामग्री).{0,30}(?:प्रदान नहीं|उपलब्ध नहीं|मौजूद नहीं|गायब|अनुपस्थित|खाली)",
    ),
    "ko": (
        r"(?:녹취록|회의 내용|회의록).{0,20}(?:제공되지|없(?:습니다|어)|누락)",
    ),
    "pt": (
        r"\bn[aã]o foi (?:fornecid[ao]|inclu[ií]d[ao]).{0,20}(?:transcri[cç][aã]o|conte[uú]do)",
        r"\b(?:transcri[cç][aã]o|conte[uú]do).{0,35}(?:n[aã]o (?:foi|est[aá]) (?:fornecid|dispon[ií]vel)|(?:est[aá]|[eé]) (?:ausente|vazi))",
    ),
}

LOCALIZED_DENIAL_RES = {
    language: re.compile("|".join(f"(?:{pattern})" for pattern in patterns), re.IGNORECASE)
    for language, patterns in DENIAL_PATTERNS.items()
}
