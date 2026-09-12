import pytest


@pytest.fixture(autouse=True)
def explicit_diagnostic_profile_for_archive_fixtures(monkeypatch):
    monkeypatch.setenv("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE", "diagnostic-hash")
