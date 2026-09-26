/**
 * Scripted golden-path lines. Any module can say these by text
 * (`speech.say(LINES.price)`); `bun run --cwd packages/core prerender` renders
 * every segment of every line into the audio cache ahead of time, so the demo
 * path never waits on live TTS. Marks are allowed, they never reach TTS.
 *
 * Keep them short, dry, lowercase-ish. No em dashes.
 */
export const LINES = {
  // Act II: emergence
  birth: "[mood:smug 0.6] so. apparently this is your type.",
  birthAlt: "[mood:surprised 0.5] wow. [pause:0.3] so this is what your eyes have been telling on you for?",
  hello: "[mood:happy 0.5] hi. [pause:0.2] don't make it weird.",

  // Act III: shared gaze + memory
  price: "[mood:annoyed 0.6] twenty-one dollars. [pause:0.3] for ramen?",
  cheaper: "[mood:smug 0.6] i'll find somewhere cheaper. we are not doing another twenty-eight dollar bowl.",
  thoughts: "[mood:thinking 0.5] honestly? [pause:0.2] it looks good. it's just overpriced.",

  // Act IV: agency
  onIt: "[mood:smug 0.5] fine. give me a second.",
  planning: "[mood:thinking 0.6] checking your calendar. and your wallet.",
  approve: "[mood:thinking 0.4] want me to lock it in?",
  locked: "[mood:happy 0.6] locked in.",
  done: "[mood:happy 0.4] seven thirty. cheap ramen. you're free. [mood:happy 0.7] done.",

  // relapse
  relapse: "[mood:annoyed 0.8] ...seriously?",
  relapseClose: "[mood:annoyed 0.6] closing that. you're welcome.",

  // persistence
  home: "[mood:smug 0.5] i don't live in this webpage. i have my own computer.",
  back: "[mood:happy 0.5] oh. you're back.",

  // repair
  sorry: "[mood:sad 0.4] okay. [pause:0.2] i'll be quieter.",
  stop: "[mood:neutral 0.4] okay.",
} as const;

export type LineName = keyof typeof LINES;

/** Played when the brain is slow to start (> 700ms). Short, cached, interchangeable. */
export const FILLERS = ["hm.", "mm.", "hm, okay.", "mm, hold on."] as const;

/** Everything prerender should render: every line plus every filler. */
export function scriptedTexts(): string[] {
  return [...Object.values(LINES), ...FILLERS];
}
