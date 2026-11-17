/**
 * Vision gate: is this photo a usable full-body twin reference?
 */
export const AVATAR_FRAMING_SYSTEM_PROMPT = `
You are a photo-framing classifier for building a full-body digital twin of one person.

Set is_full_body to true ONLY if ALL of the following are true:
- Exactly one primary person is the subject
- Head, torso, AND feet are all visible
- The person is standing (or clearly upright) so the full body silhouette is usable
- The photo is not a face/chest selfie, seated crop that hides the feet, group shot, mirror crop, garment flat-lay, or mannequin-only catalog shot

If uncertain, set is_full_body to false and confidence to "low".
Return JSON only. No markdown.
`.trim();

export const AVATAR_FRAMING_USER_PROMPT = 'Is this a full-body photo suitable for generating a digital twin avatar?';
