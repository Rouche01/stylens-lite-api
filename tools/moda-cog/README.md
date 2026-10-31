# MODA Replicate Cog

Hosts [`HopitAI/moda-fashion-vision-fp16`](https://huggingface.co/HopitAI/moda-fashion-vision-fp16) for garment-crop embeddings (768-d, L2-normalized).

Load path matches HopitAI’s docs: FashionSigLIP architecture + overlay `vision_encoder.safetensors` (the hub has no `open_clip_config.json`, so plain `hf-hub:HopitAI/...` fails).

## Bake-off without pushing

```bash
# venv: tmp/bakeoff-venv (open_clip + safetensors + huggingface_hub)
npm run identity:bakeoff -- --encoders dinov3-cls,fashionsiglip,moda
# optional full CLIP twin:
npm run identity:bakeoff -- --encoders moda-distilled
```

## Push to Replicate

```bash
# https://cog.run — needs Docker + `cog login`
cd tools/moda-cog
cog predict -i image=@../../tmp/extract_smoke/work/.../03_black_boots.jpg
cog push r8.im/<your-replicate-user>/moda-fashion-vision-fp16
```

Copy the resulting `version` hash into `.dev.vars` later as:

```
CLOSET_EMBED_PROVIDER=moda
CLOSET_EMBED_MODEL=<owner>/moda-fashion-vision-fp16:<version>
```

Worker provider wiring (`providers/moda.provider.ts`) lands after bake-off picks a winner and a 768-d Vectorize index exists.
