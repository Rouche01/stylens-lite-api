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
        "x": left edge as % of THIS image's width (0-100, one decimal),
        "y": top edge as % of THIS image's height (0-100, one decimal),
        "width": item width as % of THIS image's width (0-100, one decimal),
        "height": item height as % of THIS image's height (0-100, one decimal)
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
- Bounding boxes MUST tightly wrap only that garment's visible pixels (sleeves, collar, hems, cuffs).
- Do NOT include walls, floors, elevator panels, mirrors, phones, or empty space. The person may be off-center; measure percents against the full image, not the person crop.
- One item per box. Overlapping layers (open shirt over a tee) get separate boxes; each box should cover that layer only, even if another garment shows through.
- Under-layers peeking at the collar/hem get a small box on the visible fabric only — never a torso-tall box that also covers the outer sweater or pants.
- Do not invent socks as a separate item when only the shoe is clearly visible; prefer footwear alone.
- Bags, hats, and other worn accessories must be extracted when clearly visible (including crossbody bags).
- Do not include items in the background or held objects unless they are accessories being worn (skip phones).
- "confidence": "high" if clearly visible, "medium" if partially visible/obstructed, "low" if heavily obscured or uncertain.
- If no outfit is visible, return { "items": [] }.
- Return JSON only. No explanation, no markdown, no code fences.
`.trim();

export function outfitExtractionUserPrompt(width: number, height: number): string {
	const aspect = width >= height ? 'landscape' : 'portrait';
	return [
		`The attached JPEG is already EXIF-oriented (same pixels a phone gallery would show).`,
		`It is ${width}px wide × ${height}px tall (${aspect}). Origin is the top-left of this JPEG.`,
		`bounding_box is xywh as a percentage of THIS ${width}×${height} image — not of a square pad and not of a crop around the person.`,
		`Use one decimal place (e.g. 18.6). Do not round to 5 or 10.`,
		`A hat or cap sits on the head; y is 0 only if that item actually touches the top edge of the photo.`,
		`Extract all clothing items from this image.`,
	].join(' ');
}
