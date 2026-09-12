"""Pinned local sentence embeddings with explicit provisioning and no downloads at inference."""
from __future__ import annotations

import hashlib
import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Protocol
from urllib.request import urlopen

import numpy as np
from .retrieval import RetrievalUnavailable

MINILM_REPOSITORY = "sentence-transformers/all-MiniLM-L6-v2"
MINILM_REVISION = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
MINILM_FILES = {
    "onnx/model.onnx": "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452",
    "tokenizer.json": "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037",
}


class EmbeddingProfile(Protocol):
    profile_id: str
    dimensions: int
    max_tokens: int
    provenance: dict

    def encode(self, text: str) -> np.ndarray: ...
    def encode_batch(self, texts: list[str]) -> np.ndarray: ...


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def provision_minilm(directory: Path) -> dict:
    """An explicit setup operation downloads only immutable, hash-verified artifacts."""
    directory = directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in MINILM_FILES.items():
        target = directory / name
        if target.exists():
            if file_digest(target) != expected:
                raise ValueError(f"Existing semantic model artifact has the wrong SHA-256: {name}")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(prefix=".download-", dir=target.parent)
        try:
            with os.fdopen(descriptor, "wb") as output, urlopen(
                f"https://huggingface.co/{MINILM_REPOSITORY}/resolve/{MINILM_REVISION}/{name}", timeout=90,
            ) as source:
                received = 0
                while chunk := source.read(1024 * 1024):
                    received += len(chunk)
                    if received > 100 * 1024 * 1024:
                        raise ValueError("Semantic model artifact exceeds its download budget.")
                    output.write(chunk)
            if file_digest(Path(temporary)) != expected:
                raise ValueError(f"Downloaded semantic model artifact failed SHA-256 validation: {name}")
            os.replace(temporary, target)
        finally:
            Path(temporary).unlink(missing_ok=True)
    manifest = {"repository": MINILM_REPOSITORY, "revision": MINILM_REVISION, "files": MINILM_FILES}
    (directory / "profile.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


class MiniLmProfile:
    dimensions = 384
    max_tokens = 256
    max_source_tokens = 8192

    def __init__(self, directory: Path, *, threads: int = 2):
        if not 1 <= threads <= 8:
            raise ValueError("Semantic encoder threads must be between 1 and 8.")
        for name, expected in MINILM_FILES.items():
            source = directory / name
            if not source.is_file():
                raise RetrievalUnavailable(f"Pinned semantic model is not provisioned: {name}")
            if file_digest(source) != expected:
                raise RetrievalUnavailable(f"Pinned semantic model artifact failed SHA-256 validation: {name}")
        import onnxruntime as ort
        from onnxruntime.capi import onnxruntime_pybind11_state as runtime
        import tokenizers
        self._runtime_errors = tuple(value for value in vars(runtime).values() if isinstance(value, type) and issubclass(value, Exception))

        identity = {"kind": "semantic", "repository": MINILM_REPOSITORY, "revision": MINILM_REVISION,
                    "files": MINILM_FILES, "onnxruntime": ort.__version__, "tokenizers": tokenizers.__version__,
                    "pooling": "attention-mask-mean-l2-f32-v1", "windowPooling": "token-weighted-mean-l2-v1",
                    "passageRerank": "sentence-groups-480-chars-max8-cosine-v1",
                    "maxTokens": self.max_tokens, "maxSourceTokens": self.max_source_tokens}
        self.provenance = identity
        self.profile_id = "minilm-l6-v2-" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:24]
        self._tokenizer = tokenizers.Tokenizer.from_file(str(directory / "tokenizer.json"))
        self._tokenizer.no_padding()
        self._tokenizer.no_truncation()
        if [self._tokenizer.token_to_id(token) for token in ["[PAD]", "[CLS]", "[SEP]"]] != [0, 101, 102]:
            raise ValueError("Pinned semantic tokenizer special-token contract does not match the encoder.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        try:
            self._session = ort.InferenceSession(str(directory / "onnx/model.onnx"), sess_options=options, providers=["CPUExecutionProvider"])
        except self._runtime_errors as error:
            raise RetrievalUnavailable("Pinned semantic model could not be initialized by ONNX Runtime.") from error
        if {input.name for input in self._session.get_inputs()} != {"input_ids", "attention_mask", "token_type_ids"}:
            raise ValueError("Pinned semantic model input contract does not match the encoder.")

    def encode(self, text: str) -> np.ndarray:
        return self.encode_batch([text])[0]

    def encode_batch(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.empty((0, self.dimensions), dtype=np.float32)
        if len(texts) > 32:
            raise ValueError("Semantic encoding batches must contain at most 32 texts.")
        if any(not isinstance(text, str) or not text.strip() for text in texts):
            raise ValueError("Semantic encoding requires nonempty text.")
        tokens = self._tokenizer.encode_batch(texts, add_special_tokens=False)
        if any(len(item.ids) > self.max_source_tokens for item in tokens):
            raise ValueError("Semantic text exceeds the 8192-token source budget; split the source before encoding.")
        windows, owners, weights = [], [], []
        for owner, item in enumerate(tokens):
            for offset in range(0, max(1, len(item.ids)), self.max_tokens - 2):
                ids = item.ids[offset:offset + self.max_tokens - 2]
                windows.append([101, *ids, 102])
                owners.append(owner)
                weights.append(max(1, len(ids)))
        result = np.zeros((len(texts), self.dimensions), dtype=np.float32)
        for start in range(0, len(windows), 32):
            vectors = self._encode_windows(windows[start:start + 32])
            for index, vector in enumerate(vectors, start):
                result[owners[index]] += vector * weights[index]
        return self._normalize(result)

    def _encode_windows(self, windows: list[list[int]]) -> np.ndarray:
        width = max(map(len, windows))
        ids = np.asarray([window + [0] * (width - len(window)) for window in windows], dtype=np.int64)
        inputs = {
            "input_ids": ids,
            "attention_mask": (ids != 0).astype(np.int64),
            "token_type_ids": np.zeros_like(ids),
        }
        try:
            embeddings = self._session.run(None, inputs)[0]
        except self._runtime_errors as error:
            raise RetrievalUnavailable("Pinned semantic model inference failed in ONNX Runtime.") from error
        mask = inputs["attention_mask"][..., None].astype(np.float32)
        pooled = (embeddings * mask).sum(axis=1) / mask.sum(axis=1)
        return self._normalize(pooled)

    def _normalize(self, vectors: np.ndarray) -> np.ndarray:
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        if vectors.ndim != 2 or vectors.shape[1] != self.dimensions or not np.isfinite(vectors).all() or np.any(norms == 0):
            raise RetrievalUnavailable("Semantic model returned invalid sentence embeddings.")
        return (vectors / norms).astype(np.float32)


def configured_model_directory(archive_root: Path | None = None) -> Path:
    root = archive_root if archive_root is not None else Path(os.getenv("CLOUDX_DOCUMENTATION_DATA_DIR", ".cloudx/documentation"))
    return Path(os.getenv("CLOUDX_DOCUMENTATION_MODEL_DIR", str(root / "models" / "minilm"))).expanduser()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Provision pinned, checksum-verified local semantic retrieval assets.")
    parser.add_argument("directory", nargs="?", type=Path, help="Model directory; defaults to CLOUDX_DOCUMENTATION_MODEL_DIR or DATA_DIR/models/minilm.")
    arguments = parser.parse_args(argv)
    print(json.dumps(provision_minilm(arguments.directory.expanduser() if arguments.directory is not None else configured_model_directory()), indent=2))


def configured_profile(archive_root: Path) -> EmbeddingProfile | None:
    profile = os.getenv("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE", "minilm")
    if profile == "diagnostic-hash":
        return None
    if profile != "minilm":
        raise ValueError("CLOUDX_DOCUMENTATION_RETRIEVAL_PROFILE must be minilm or diagnostic-hash.")
    return MiniLmProfile(configured_model_directory(archive_root))


if __name__ == "__main__":
    main()
