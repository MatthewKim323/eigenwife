import type { Mood } from "@eigenwife/protocol";

/**
 * gpt-live-1 speaks every token it writes, so inline [mood:x] marks would be
 * read out loud. Her face follows a cheap read of her own transcript instead:
 * one keyword pass per finished sentence, well under a millisecond.
 */
const RULES: [RegExp, Mood, number][] = [
  [/\b(?:ugh|seriously|stop it|come on|are you kidding|not again|excuse me|rude)\b/i, "annoyed", 0.7],
  [/\b(?:wait,? what|no way|oh my god|omg|what\?!|whoa|wow|really\?)\b|!\?/i, "surprised", 0.75],
  [/\b(?:obviously|told you|of course|naturally|i know|you'?re welcome|called it|clearly)\b/i, "smug", 0.65],
  [/\b(?:sorry|aw+|oh no|that sucks|i miss|sad|rough|poor thing|i'?m here)\b/i, "sad", 0.55],
  [/\b(?:hmm+|let me think|let me check|one sec|checking|looking|give me a sec|lemme see)\b/i, "thinking", 0.6],
  [/\b(?:haha+|hehe+|lol|love (?:it|that)|yay|nice|cute|perfect|amazing|fun|ooh|finally|bet)\b|!$/i, "happy", 0.7],
];

export function moodOf(text: string): { mood: Mood; intensity: number } | null {
  const t = text.trim();
  if (!t) return null;
  for (const [re, mood, intensity] of RULES) if (re.test(t)) return { mood, intensity };
  return null;
}

/** Split a growing transcript into finished sentences (the tail stays open). */
export function finishedSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^.!?]+[.!?]+(?:["')\]]+)?(?=\s|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[0].trim());
  return out;
}
