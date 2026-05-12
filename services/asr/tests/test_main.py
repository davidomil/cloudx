from types import SimpleNamespace

from fastapi.testclient import TestClient

from cloudx_asr import main


class FakeModel:
    def transcribe(self, path, beam_size, vad_filter, initial_prompt):
        assert beam_size == 5
        assert vad_filter is True
        assert path
        return [SimpleNamespace(text=" hello")], SimpleNamespace(language="en", language_probability=0.99)


def test_health():
    client = TestClient(main.app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_transcribe_with_fake_model(monkeypatch):
    monkeypatch.setattr(main, "get_model", lambda: FakeModel())
    client = TestClient(main.app)

    response = client.post(
        "/transcribe",
        files={"audio": ("voice.webm", b"fake-audio", "audio/webm")},
        data={"context": "Cloudx"},
    )

    assert response.status_code == 200
    assert response.json()["text"] == "hello"
