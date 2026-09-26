/**
 * "what do you think of this", "thoughts?", "can you see this": an utterance
 * that points at the screen. Keyword based like reflex/intent.ts. Used by the
 * reflex router to decide whether to take a level 3 look before answering.
 */

const EXPLICIT =
  /\b(?:(?:can|do) you see (?:this|that|my screen)|you see (?:this|that)|look(?:ing)? at (?:this|that|my screen)|check (?:this|that) out|what am i looking at|what(?:'s| is) (?:on )?my screen|what(?:'s| is) (?:this|that)(?: thing)?|what do you think (?:of|about) (?:this|that)|how does (?:this|that) look|is (?:this|that) (?:good|mid|fire|bad|ugly|cute|worth it|legit)|should i (?:buy|get|cop|wear|watch|read) (?:this|that)|rate (?:this|that)|what does (?:this|that) (?:say|mean)|what(?:'s| is) wrong (?:with|here)|why is (?:this|that) (?:broken|failing|red))\b/i;
const BARE = /^(?:thoughts|any thoughts|opinions?|yay or nay|rate it|thoughts on this|well|so)\s*\?+\s*$/i;
const DEICTIC = /\b(?:this|that|these|those|this one|that one|here)\b/i;
const QUESTION = /\?\s*$|^(?:what|whats|what's|how|is|are|should|would|do|does|can|could|which|why)\b/i;

export function screenDeictic(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).length;
  if (words > 14) return false;
  if (EXPLICIT.test(t) || BARE.test(t)) return true;
  return words <= 8 && DEICTIC.test(t) && QUESTION.test(t);
}
