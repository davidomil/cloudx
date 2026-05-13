from types import SimpleNamespace

from fastapi.testclient import TestClient

from cloudx_asr import main

VALID_FAKE_AUDIO = b"fake-audio" * 20


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, path, **kwargs):
        self.calls.append(kwargs)
        assert kwargs["beam_size"] == 5
        assert kwargs["vad_filter"] is False
        assert path
        return [SimpleNamespace(text=" hello")], SimpleNamespace(language="en", language_probability=0.99)


class EmptyModel:
    def transcribe(self, path, **kwargs):
        assert path
        return [], SimpleNamespace(language="en", language_probability=0.99)


class PartialModel:
    def transcribe(self, path, **kwargs):
        assert path
        if kwargs["beam_size"] == 1:
            return [SimpleNamespace(text=" partial text")], SimpleNamespace(language="en", language_probability=0.99)
        return [SimpleNamespace(text=" final text")], SimpleNamespace(language="en", language_probability=0.99)


def test_health():
    client = TestClient(main.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_transcribe_with_fake_model(monkeypatch):
    reset_asr_env(monkeypatch)
    model = FakeModel()
    monkeypatch.setattr(main, "get_model", lambda: model)
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", VALID_FAKE_AUDIO, "audio/webm")},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "hello"
    call = model.calls[0]
    assert call["language"] == "en"
    assert call["task"] == "transcribe"
    assert call["temperature"] == 0.0
    assert call["condition_on_previous_text"] is False
    assert call["max_new_tokens"] == 96
    assert call["initial_prompt"] is None
    assert call["hotwords"] is None


def test_transcribe_websocket_with_fake_model(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO[:80])
        websocket.send_bytes(VALID_FAKE_AUDIO[80:])
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == "hello"


def test_transcribe_websocket_redacts_transcript_text_from_logs_by_default(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        websocket.receive_json()
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        websocket.receive_json()
        websocket.receive_json()

    output = capsys.readouterr().out
    assert '"event": "asr_websocket_transcription_completed"' in output
    assert '"text_chars": 5' in output
    assert '"text": "hello"' not in output


def test_transcribe_websocket_logs_transcript_text_when_debug_enabled(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_VOICE_DEBUG_TRANSCRIPTS", "true")
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        websocket.receive_json()
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        websocket.receive_json()
        websocket.receive_json()

    assert '"text": "hello"' in capsys.readouterr().out


def test_transcribe_websocket_can_return_empty_text(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: EmptyModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO)
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == ""


def test_transcribe_websocket_rejects_tiny_audio_before_decode(monkeypatch, capsys):
    reset_asr_env(monkeypatch)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(b"audio")
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        error = websocket.receive_json()

    assert error["type"] == "error"
    assert "too small to decode" in error["message"]
    output = capsys.readouterr().out
    assert '"event": "asr_websocket_invalid_audio"' in output
    assert '"audio_bytes": 5' in output
    assert '"first_bytes_hex": "617564696f"' in output


def test_transcribe_websocket_sends_partial_transcripts(monkeypatch):
    reset_asr_env(monkeypatch)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setattr(main, "get_model", lambda: PartialModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(VALID_FAKE_AUDIO)
        partial = websocket.receive_json()
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert partial == {"type": "partial", "text": "partial text"}
    assert transcript["type"] == "transcript"
    assert transcript["text"] == "final text"


def test_vad_filter_can_be_enabled(monkeypatch):
    monkeypatch.setenv("CLOUDX_ASR_VAD_FILTER", "true")

    assert main.use_vad_filter() is True


def test_language_can_be_set_to_auto(monkeypatch):
    monkeypatch.setenv("CLOUDX_ASR_LANGUAGE", "auto")

    assert main.transcription_language() is None


def test_partial_audio_window_keeps_header_and_recent_bytes():
    window = main.PartialAudioWindow(max_recent_bytes=7)

    window.push(b"header")
    window.push(b"old")
    window.push(b"new")
    window.push(b"last")

    assert window.chunks() == [b"header", b"new", b"last"]


def reset_asr_env(monkeypatch):
    for name in [
        "CLOUDX_ASR_BEAM_SIZE",
        "CLOUDX_ASR_CONDITION_ON_PREVIOUS_TEXT",
        "CLOUDX_ASR_LANGUAGE",
        "CLOUDX_ASR_MAX_NEW_TOKENS",
        "CLOUDX_ASR_PARTIAL_BEAM_SIZE",
        "CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS",
        "CLOUDX_ASR_PARTIAL_MIN_BYTES",
        "CLOUDX_ASR_PARTIAL_WINDOW_BYTES",
        "CLOUDX_ASR_TEMPERATURE",
        "CLOUDX_ASR_VAD_FILTER",
        "CLOUDX_VOICE_DEBUG_TRANSCRIPTS",
    ]:
        monkeypatch.delenv(name, raising=False)
