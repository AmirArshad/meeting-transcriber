from common.sensitive_text import redact_sensitive_text


def test_redact_sensitive_text_removes_hf_tokens_and_bearer_values():
    raw = (
        "Authorization: Bearer abc.DEF_123 "
        "https://user:secret@huggingface.co/model?token=secret "
        "hf_secret_token"
    )
    cleaned = redact_sensitive_text(raw)

    assert "abc.DEF_123" not in cleaned
    assert "user:secret" not in cleaned
    assert "token=secret" not in cleaned
    assert "hf_secret_token" not in cleaned
    assert "Bearer [redacted-token]" in cleaned
    assert "https://[redacted]@huggingface.co" in cleaned


def test_redact_sensitive_text_respects_max_length():
    cleaned = redact_sensitive_text("x" * 500, max_length=40)
    assert len(cleaned) == 40
