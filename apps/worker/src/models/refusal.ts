const REFUSAL_MARKERS = [
  "i can't help with that",
  'i cannot help with that',
  "i won't assist",
  'i am not able to assist',
  'i cannot assist with that',
  'i can not provide',
]

/**
 * Detects a soft refusal in model output text. The Anthropic SDK also surfaces
 * a hard `refusal` stop reason; providers set `refused` directly for that case.
 * This catches the softer in-band refusals that still waste an attack slot.
 */
export function looksLikeRefusal(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  if (normalized.length === 0) {
    return false
  }
  return REFUSAL_MARKERS.some((marker) => normalized.includes(marker))
}
