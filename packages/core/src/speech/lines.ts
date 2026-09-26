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

/** Touch reactions: pre-rendered so she answers a pat or a poke instantly, mood marks match her face. */
export const TOUCH_LINES = {
  pat: [
    "[mood:happy 0.8] mmm. okay, that's nice.",
    "[mood:happy 0.7] hehe. again?",
    "[mood:happy 0.7] i could get used to this.",
    "[mood:happy 0.6] don't stop.",
    "[mood:surprised 0.5] oh. head pats. bold of you.",
    "[mood:happy 0.7] good pat. seven out of ten.",
  ],
  poke: [
    "[mood:surprised 0.6] hey!",
    "[mood:surprised 0.5] yes? can i help you?",
    "[mood:smug 0.5] that tickles.",
    "[mood:surprised 0.6] rude.",
    "[mood:neutral 0.5] i'm right here, you know.",
    "[mood:smug 0.5] what. you miss me?",
  ],
  annoyed: [
    "[mood:annoyed 0.8] okay. stop poking me.",
    "[mood:annoyed 0.8] one more and i'm closing your tabs.",
    "[mood:annoyed 0.7] do you poke all your girlfriends like this?",
    "[mood:annoyed 0.8] i will bite.",
  ],
  boop: ["[mood:surprised 0.6] did you just boop me.", "[mood:happy 0.6] hehe. my nose.", "[mood:smug 0.5] boop? really? okay."],
  ears: [
    "[mood:happy 0.7] hey, the ears are sensitive.",
    "[mood:happy 0.6] mmm. okay, ear scratches are allowed.",
    "[mood:surprised 0.6] ears are off limits. mostly.",
  ],
  chest: [
    "[mood:annoyed 0.7] hey. eyes up here.",
    "[mood:surprised 0.8] excuse me??",
    "[mood:smug 0.6] buy me dinner first. the cheap ramen place.",
    "[mood:annoyed 0.7] that's not a button.",
    "[mood:annoyed 0.8] bold. very bold. no.",
  ],
  tickle: ["[mood:happy 0.8] hey! that tickles!", "[mood:happy 0.7] stop, i'm ticklish.", "[mood:surprised 0.6] my stomach is not a trackpad."],
  drag: ["[mood:surprised 0.7] woah, woah.", "[mood:surprised 0.6] where are we going?", "[mood:surprised 0.6] hey, put me down."],
  drop: ["[mood:neutral 0.5] okay. i like it here.", "[mood:smug 0.5] nice view.", "[mood:neutral 0.4] fine. i live here now."],
} as const;
export type TouchKind = keyof typeof TOUCH_LINES;

/** Everything prerender should render: every line, every touch line, every filler. */
export function scriptedTexts(): string[] {
  return [...Object.values(LINES), ...Object.values(TOUCH_LINES).flat(), ...FILLERS];
}
