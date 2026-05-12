from types import SimpleNamespace

from fastapi.testclient import TestClient

from cloudx_asr import main


class FakeModel:
    def transcribe(self, path, beam_size, vad_filter, initial_prompt):
        assert beam_size == 5
        assert vad_filter is False
        assert path
        return [SimpleNamespace(text=" hello")], SimpleNamespace(language="en", language_probability=0.99)


class EmptyModel:
    def transcribe(self, path, beam_size, vad_filter, initial_prompt):
        assert path
        return [], SimpleNamespace(language="en", language_probability=0.99)


class PartialModel:
    def transcribe(self, path, beam_size, vad_filter, initial_prompt):
        assert path
        if beam_size == 1:
            return [SimpleNamespace(text=" partial text")], SimpleNamespace(language="en", language_probability=0.99)
        return [SimpleNamespace(text=" final text")], SimpleNamespace(language="en", language_probability=0.99)


def test_health():
    client = TestClient(main.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_transcribe_with_fake_model(monkeypatch):
    monkeypatch.delenv("CLOUDX_ASR_VAD_FILTER", raising=False)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", b"fake-audio", "audio/webm")},
        data={"context": "Cloudx"},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "hello"


def test_transcribe_websocket_with_fake_model(monkeypatch):
    monkeypatch.delenv("CLOUDX_ASR_VAD_FILTER", raising=False)
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm", "context": "Cloudx"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(b"fake-")
        websocket.send_bytes(b"audio")
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == "hello"


def test_transcribe_websocket_can_return_empty_text(monkeypatch):
    monkeypatch.delenv("CLOUDX_ASR_VAD_FILTER", raising=False)
    monkeypatch.setattr(main, "get_model", lambda: EmptyModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm", "context": "Cloudx"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(b"fake-audio")
        websocket.send_json({"type": "end"})
        assert websocket.receive_json() == {"type": "status", "status": "transcribing"}
        transcript = websocket.receive_json()

    assert transcript["type"] == "transcript"
    assert transcript["text"] == ""


def test_transcribe_websocket_sends_partial_transcripts(monkeypatch):
    monkeypatch.delenv("CLOUDX_ASR_VAD_FILTER", raising=False)
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_INTERVAL_SECONDS", "0")
    monkeypatch.setenv("CLOUDX_ASR_PARTIAL_MIN_BYTES", "1")
    monkeypatch.setattr(main, "get_model", lambda: PartialModel())
    client = TestClient(main.app)

    with client.websocket_connect("/transcribe/ws") as websocket:
        websocket.send_json({"type": "start", "filename": "voice.webm", "context": "Cloudx"})
        assert websocket.receive_json() == {"type": "status", "status": "receiving"}
        websocket.send_bytes(b"fake-audio")
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
