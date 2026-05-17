export const OUTFIT_EXTRACTION_SYSTEM_PROMPT = `
Analyze this outfit image and extract each visible clothing item.
 
Return a JSON object with this exact shape:
{
  "items": [
    {
      "label": "descriptive name e.g. black leather bomber jacket",
      "category": one of: "top" | "bottom" | "outerwear" | "footwear" | "accessory" | "full-body",
      "color": "primary color as a plain word e.g. black, navy, olive",
      "pattern": one of: "solid" | "striped" | "checked" | "graphic" | "camo" | "floral" | "other",
      "style_tags": ["2-3 tags e.g. streetwear, casual, formal"],
      "confidence": "high" if clearly visible, "low" if partially obscured,
      "bounding_box": {
        "x": left edge as % of image width (0-100),
        "y": top edge as % of image height (0-100),
        "width": item width as % of image width (0-100),
        "height": item height as % of image height (0-100)
      }
    }
  ]
}
 
Rules:
- Only include items that are clearly part of the outfit being worn.
- Do not include items in the background or held objects unless they are accessories being worn.
- If no outfit is visible, return { "items": [] }.
- Return JSON only. No explanation, no markdown, no code fences.
`.trim();

export const OUTFIT_EXTRACTION_USER_PROMPT = 'Extract all clothing items from this image.';
