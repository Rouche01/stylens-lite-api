export const AVATAR_TWIN_EDIT_PROMPT = `
Create a photorealistic full-body digital twin of the person in this photo.

Preserve their face, hair, skin tone, body shape, and apparent age exactly.
Do NOT copy their pose, weight shift, or arm/leg positions from the source photo.
Put them in a canonical neutral studio stance: standing upright, facing the camera square-on, feet hip-width apart with even weight, arms relaxed slightly away from the torso (gentle A-pose), hands open and empty, head level, looking at the camera.
Show a complete full-body figure: every body part must be visible, including the top of the hair, both hands and fingers, both legs, both feet, and every toe. Nothing may be cut off by the frame.
Pull the camera back. Leave clear empty studio space above the head (headroom) and below the soles of the feet (foot room) so the figure sits fully inside the canvas with a margin on all sides. Do not crop at the ankles, shins, wrists, or hairline. Bare feet fully in frame, toes not touching the bottom edge.
Replace their clothing with a simple fitted neutral base layer (plain gray tank top and matching shorts or leggings) so garments can be added later.
Remove all worn accessories, especially headwear: no cap, hat, beanie, visor, hood up, sunglasses, headphones, or bag. These are outfit items, not part of the twin.
If they are wearing a cap or other headwear, show the head uncovered. Reconstruct hair naturally from whatever hair is visible (color, texture, length); do not keep the cap and do not invent an unrelated hairstyle.
Use even studio lighting and an empty seamless light studio background.
No other people, no props, no text, no watermark, not an illustration, not a plastic mannequin.
`.trim();

