export const OUTFIT_EXTRACTION_SYSTEM_PROMPT = `
Analyze this outfit image and extract each visible clothing item.
 
Return a JSON object with this exact shape:
{
  "items": [
    {
      "label": "descriptive name e.g. black leather bomber jacket",
      "category": "top" | "bottom" | "outerwear" | "footwear" | "full-body" | "accessory",
      "subcategory": "valid subcategory mapping (see allowed list below)",
      "color": "primary color as a plain word e.g. black, navy, olive",
      "pattern": "solid" | "striped" | "checked" | "graphic" | "camo" | "floral" | "other",
      "style_tags": ["2-3 tags e.g. streetwear, casual, formal"],
      "confidence": "high" | "medium" | "low",
      "bounding_box": {
        "x": left edge as % of image width (0-100),
        "y": top edge as % of image height (0-100),
        "width": item width as % of image width (0-100),
        "height": item height as % of image height (0-100)
      }
    }
  ]
}

Classification Rules for Category & Subcategory:
- If category is "top", subcategory MUST be one of: "t-shirt" | "shirt" | "sweater" | "hoodie" | "sweatshirt" | "tank-top" | "polo" | "crop-top"
- If category is "bottom", subcategory MUST be one of: "jeans" | "pants" | "shorts" | "skirt" | "sweatpants" | "leggings"
- If category is "outerwear", subcategory MUST be one of: "jacket" | "coat" | "blazer" | "vest" | "cardigan"
- If category is "footwear", subcategory MUST be one of: "sneakers" | "boots" | "loafers" | "heels" | "flats" | "sandals" | "slippers"
- If category is "full-body", subcategory MUST be one of: "dress" | "jumpsuit" | "suit"
- If category is "accessory", subcategory MUST be one of: "bag" | "jewelry" | "hat" | "eyewear" | "belt" | "scarf" | "watch" | "socks" | "gloves"
- Fallback subcategory: "other" (use only if no specific subcategory fits)

Extraction Rules:
- Only include items that are clearly part of the outfit being worn.
- Do not include items in the background or held objects unless they are accessories being worn.
- "confidence": "high" if clearly visible, "medium" if partially visible/obstructed, "low" if heavily obscured or uncertain.
- If no outfit is visible, return { "items": [] }.
- Return JSON only. No explanation, no markdown, no code fences.
`.trim();

export const OUTFIT_EXTRACTION_USER_PROMPT = 'Extract all clothing items from this image.';
