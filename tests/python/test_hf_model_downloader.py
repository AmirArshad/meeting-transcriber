import hashlib

import pytest

from backend.summaries import hf_model_downloader


def test_hugging_face_downloader_confines_destination_and_requires_checksum(tmp_path):
    with pytest.raises(ValueError, match='checksum'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='model.gguf',
            destination=str(tmp_path / 'model.gguf'),
            destination_root=str(tmp_path),
            expected_sha256='',
        )

    with pytest.raises(ValueError, match='outside'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='model.gguf',
            destination=str(tmp_path.parent / 'escape.gguf'),
            destination_root=str(tmp_path),
            expected_sha256='a' * 64,
        )

    with pytest.raises(ValueError, match='temporary download directory'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='model.gguf',
            destination=str(tmp_path / 'cache' / 'model.gguf'),
            destination_root=str(tmp_path / 'cache' / 'model.gguf'),
            expected_sha256='a' * 64,
        )


def test_hugging_face_downloader_rejects_unsafe_filename(tmp_path):
    with pytest.raises(ValueError, match='basename'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='../model.gguf',
            destination=str(tmp_path / 'model.gguf'),
            destination_root=str(tmp_path),
            expected_sha256='a' * 64,
        )

    with pytest.raises(ValueError, match='basename'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='..\\model.gguf',
            destination=str(tmp_path / 'model.gguf'),
            destination_root=str(tmp_path),
            expected_sha256='a' * 64,
        )


def test_hugging_face_downloader_verifies_checksum_before_move(tmp_path, monkeypatch):
    destination = tmp_path / 'cache' / 'model.gguf'
    expected_sha = hashlib.sha256(b'model bytes').hexdigest()

    def fake_download(**kwargs):
        source = tmp_path / 'cache' / 'model.gguf.hf-download' / 'model.gguf'
        assert kwargs['local_dir'] == str(source.parent)
        source.write_bytes(b'model bytes')
        return str(source)

    # The function imports hf_hub_download locally, so intercept import by
    # replacing the import target in sys.modules.
    import types
    import sys
    fake_module = types.SimpleNamespace(hf_hub_download=fake_download)
    monkeypatch.setitem(sys.modules, 'huggingface_hub', fake_module)

    result = hf_model_downloader.download_hugging_face_file(
        repo='owner/model',
        revision='abc123',
        filename='model.gguf',
        destination=str(destination),
        destination_root=str(destination.parent),
        expected_sha256=expected_sha,
    )

    assert result['status'] == 'ok'
    assert destination.read_bytes() == b'model bytes'


def test_hugging_face_downloader_rejects_unexpected_external_download_path(tmp_path, monkeypatch):
    outside = tmp_path / 'model.gguf'
    outside.write_bytes(b'model bytes')
    expected_sha = hashlib.sha256(outside.read_bytes()).hexdigest()

    import types
    import sys
    monkeypatch.setitem(sys.modules, 'huggingface_hub', types.SimpleNamespace(hf_hub_download=lambda **_kwargs: str(outside)))

    destination = tmp_path / 'cache' / 'model.gguf'
    with pytest.raises(RuntimeError, match='temporary download directory'):
        hf_model_downloader.download_hugging_face_file(
            repo='owner/model',
            revision='abc123',
            filename='model.gguf',
            destination=str(destination),
            destination_root=str(destination.parent),
            expected_sha256=expected_sha,
        )
