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
- If category is "accessory", subcategory MUST be one of: "bag" | "hat" (caps use "hat")
- Fallback subcategory: "other" (use only if no specific subcategory fits — still omit from accessories below)

Extraction Rules:
- Only include items that are clearly part of the outfit being worn.
- Bounding boxes MUST tightly wrap only that garment's visible pixels (sleeves, collar, hems, cuffs).
- Do NOT include walls, floors, elevator panels, mirrors, phones, or empty space. The person may be off-center; measure percents against the full image, not the person crop.
- One item per box. Overlapping layers get separate boxes only when the under-layer is substantially visible as its own garment (e.g. open jacket showing most of a shirt). Each box should cover that layer only.
- Do NOT extract base layers that only peek as a collar rim, hoodie hem strip, or waistband under another top/outerwear — those are not closet items. Never invent a "band", "strip", or "waistband" garment from a hem peek.
- Accessories: extract ONLY a bag or hat/cap when clearly worn (including crossbody bags). Do NOT extract socks, gloves, jewelry, watches, eyewear, belts, scarves, headphones/earbuds, or phones.
- Prefer footwear alone; never invent socks from shoes.
- "color" must be a single primary word or hyphenated shade (e.g. black, navy, light-blue). Do not hedge with "or" (bad: "dark navy or black"). For jeans, prefer light / medium / dark plus hue when obvious (e.g. light-blue, dark-indigo).
- Do not include items in the background or held objects unless they are a bag or hat being worn.
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
		`Extract garments plus bag/hat only from this image.`,
	].join(' ');
}
