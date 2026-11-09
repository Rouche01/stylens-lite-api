"""Replicate Predictor: HopitAI MODA fashion vision-fp16 → L2-normalized 768-d embedding."""

from __future__ import annotations

import urllib.request
from typing import List

import open_clip
import torch
import torch.nn.functional as F
from cog import BasePredictor, Input, Path
from huggingface_hub import hf_hub_download
from PIL import Image
from safetensors.torch import load_file

# Vision tower only (~186 MB). Official load overlays onto FashionSigLIP architecture.
REPO_ID = "HopitAI/moda-fashion-vision-fp16"
BASE_HUB = "hf-hub:Marqo/marqo-fashionSigLIP"


class Predictor(BasePredictor):
    def setup(self) -> None:
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        model, _, self.preprocess = open_clip.create_model_and_transforms(BASE_HUB)
        weights_path = hf_hub_download(repo_id=REPO_ID, filename="vision_encoder.safetensors")
        vision_sd = {k: v.float() for k, v in load_file(weights_path).items()}
        full_sd = model.state_dict()
        for k, v in vision_sd.items():
            full_sd[k] = v
        model.load_state_dict(full_sd, strict=True)
        self.encoder = model.visual.to(self.device).eval()

    def predict(
        self,
        image: Path = Input(description="Garment crop JPEG/PNG"),
        image_url: str = Input(
            description="Optional HTTPS image URL (used if image unset)", default=""
        ),
    ) -> List[float]:
        pil = self._load_image(image, image_url)
        tensor = self.preprocess(pil.convert("RGB")).unsqueeze(0).to(self.device)
        with torch.no_grad():
            vec = self.encoder(tensor)
            vec = F.normalize(vec, p=2, dim=-1)
        return vec[0].detach().cpu().tolist()

    def _load_image(self, image: Path | None, image_url: str) -> Image.Image:
        url = (image_url or "").strip()
        if url.startswith("http://") or url.startswith("https://"):
            with urllib.request.urlopen(url, timeout=60) as resp:
                return Image.open(resp).convert("RGB")
        if image is None:
            raise ValueError("Provide image or image_url")
        return Image.open(image).convert("RGB")
