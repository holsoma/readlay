"""Kokoro is imported only by the local generation command."""

from __future__ import annotations

import hashlib
import importlib.metadata
import os
import sys
from pathlib import Path

from .core import PreparationError, file_digest


class KokoroProvider:
    def __init__(self, voice: str, language: str, revision: str, allow_download: bool = False, device: str = "cpu"):
        if not (3, 10) <= sys.version_info[:2] < (3, 14):
            raise PreparationError("Kokoro 0.9.4 needs Python 3.10 to 3.13. Create a separate Python 3.12 environment for audio preparation.")
        if not allow_download:
            os.environ["HF_HUB_OFFLINE"] = "1"
            os.environ["TRANSFORMERS_OFFLINE"] = "1"
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        os.environ.setdefault("HF_HOME", str(Path(__file__).resolve().parents[2] / ".local" / "audio-models"))
        os.environ.setdefault("OMP_NUM_THREADS", "4")
        print("Loading local Kokoro inference libraries.", flush=True)
        try:
            import numpy as np
            import spacy
            import torch
            from huggingface_hub import hf_hub_download
            from kokoro import KModel, KPipeline
        except ImportError as error:
            raise PreparationError("Install requirements-audio.txt in the separate Python audio environment first.") from error
        if not spacy.util.is_package("en_core_web_sm"):
            raise PreparationError("Install the English language package once with: python -m spacy download en_core_web_sm. Generation does not install it automatically.")
        repo = "hexgrad/Kokoro-82M"
        print("Preparing selected model and voice assets." if allow_download else "Checking cached model and voice assets (offline).", flush=True)
        try:
            paths = {name: Path(hf_hub_download(repo_id=repo, filename=name, revision=revision, local_files_only=not allow_download)) for name in ("config.json", "kokoro-v1_0.pth", f"voices/{voice}.pt")}
        except Exception as error:
            raise PreparationError("The selected Kokoro model or voice is not cached. Run the same command once with --allow-download, then use offline generation.") from error
        self.fingerprint = {
            "engine": "kokoro", "version": importlib.metadata.version("kokoro"),
            "misakiVersion": importlib.metadata.version("misaki"), "torchVersion": torch.__version__,
            "languageModelVersion": importlib.metadata.version("en-core-web-sm"),
            "modelHash": file_digest(paths["kokoro-v1_0.pth"]),
            "configHash": file_digest(paths["config.json"]), "voiceHash": file_digest(paths[f"voices/{voice}.pt"]),
            "voice": voice, "language": language, "speed": 1, "device": device,
            "seedAlgorithm": "text-sha256-v1",
        }
        self.np = np
        self.torch = torch
        try:
            model = KModel(repo_id=repo, config=str(paths["config.json"]), model=str(paths["kokoro-v1_0.pth"])).to(device).eval()
            self.pipeline = KPipeline(lang_code=language, repo_id=repo, model=model, device=device)
            self.voice = torch.load(paths[f"voices/{voice}.pt"], map_location="cpu", weights_only=True)
        except Exception as error:
            raise PreparationError("Kokoro could not initialise. Check the installed packages, espeak-ng, and the selected device.") from error
        print("Kokoro is ready for local narration.", flush=True)

    def pcm_chunks(self, text: str):
        # Kokoro's waveform decoder adds noise even in eval mode. Seed per text
        # chunk so rebuilding a missing cache does not depend on chapter order.
        self.torch.manual_seed(int(hashlib.sha256(text.encode("utf-8")).hexdigest()[:16], 16))
        # Check phonemes before Kokoro's internal 510-phoneme truncation guard.
        _, tokens = self.pipeline.g2p(text)
        if any(len(phonemes) > 510 for _, phonemes, _ in self.pipeline.en_tokenize(tokens)):
            raise PreparationError("A chunk exceeds Kokoro's phoneme limit. Re-run with a smaller --max-chars value.")
        for _, _, audio in self.pipeline(text, voice=self.voice, speed=1, split_pattern=None):
            if audio is None:
                raise PreparationError("Kokoro returned no narration audio.")
            values = audio.detach().cpu().numpy().reshape(-1)
            if not self.np.isfinite(values).all():
                raise PreparationError("Kokoro returned non-finite audio samples.")
            yield (self.np.clip(values, -1, 1) * 32767).round().astype("<i2").tobytes()
