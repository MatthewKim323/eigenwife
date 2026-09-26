import type { TraitVector } from "./index";

/**
 * Act I dataset: fictional, clearly synthetic profiles with hidden trait
 * vectors. Attention on these is what "compiles" Eve. Owned by the shell
 * builder (content), consumed by core preference math.
 *
 * Every person here is invented. Portraits are stylized anime illustrations
 * generated for the demo (apps/shell/public/candidates/<id>-1.webp, -2.webp).
 */

export const TRAIT_GROUPS = {
  appearance: ["style", "sporty", "alternative", "polished"],
  personality: ["humor", "sarcasm", "warmth", "ambition", "spontaneity", "nerdiness", "chaos"],
  lifestyle: ["nightlife", "outdoors", "fitness", "travel", "career_focus"],
} as const;

export type TraitKey = (typeof TRAIT_GROUPS)[keyof typeof TRAIT_GROUPS][number];
export const TRAIT_KEYS: readonly TraitKey[] = Object.values(TRAIT_GROUPS).flat() as TraitKey[];

export interface CandidateRegion {
  /** Region id, unique within the candidate: "photo1", "prompt2", "meta". */
  id: string;
  kind: "profile-photo" | "profile-prompt" | "profile-meta";
  /** Which traits this region expresses most, 0..1. Attention here is evidence for these. */
  emphasis: Partial<Record<TraitKey, number>>;
}

export interface Candidate {
  id: string;
  name: string;
  age: number;
  tagline: string;
  job: string;
  location: string;
  photos: { id: string; src: string; caption: string }[];
  prompts: { id: string; question: string; answer: string }[];
  /** Hidden ground truth, 0..1 per trait. */
  traits: Record<TraitKey, number>;
  regions: CandidateRegion[];
}

/** data-gaze key for a candidate region. The shell and the core must agree on this. */
export function regionKey(candidateId: string, regionId: string): string {
  return `cand_${candidateId}_${regionId}`;
}

export function traitVector(c: Candidate): TraitVector {
  return { ...c.traits };
}

type Traits = Record<TraitKey, number>;
type Emph = Partial<Record<TraitKey, number>>;

interface Draft {
  id: string;
  name: string;
  age: number;
  tagline: string;
  job: string;
  location: string;
  captions: [string, string];
  prompts: [[string, string], [string, string], [string, string]];
  traits: Traits;
  /** Emphasis for photo1, photo2, prompt1..3, meta. */
  emphasis: [Emph, Emph, Emph, Emph, Emph, Emph];
}

function build(d: Draft): Candidate {
  const regionIds = ["photo1", "photo2", "prompt1", "prompt2", "prompt3", "meta"] as const;
  const kinds = ["profile-photo", "profile-photo", "profile-prompt", "profile-prompt", "profile-prompt", "profile-meta"] as const;
  return {
    id: d.id,
    name: d.name,
    age: d.age,
    tagline: d.tagline,
    job: d.job,
    location: d.location,
    photos: d.captions.map((caption, i) => ({ id: `photo${i + 1}`, src: `/candidates/${d.id}-${i + 1}.webp`, caption })),
    prompts: d.prompts.map(([question, answer], i) => ({ id: `prompt${i + 1}`, question, answer })),
    traits: d.traits,
    regions: regionIds.map((id, i) => ({ id, kind: kinds[i]!, emphasis: d.emphasis[i]! })),
  };
}

/** Keep ids stable once shipped: the core and the gaze keys depend on them. */
export const CANDIDATES: Candidate[] = [
  build({
    id: "mira",
    name: "Mira",
    age: 27,
    tagline: "will debug your life, unprompted",
    job: "Firmware engineer",
    location: "Oakland",
    captions: ["soldering at 1am, as one does", "the cat is a senior engineer now"],
    prompts: [
      ["I'm weirdly attracted to", "People who read the error message before panicking. Rare. Endangered. Extremely hot."],
      ["My most controversial opinion", "Tabs. I will die on a hill made entirely of tabs, indented correctly."],
      ["We'll get along if", "You can handle me narrating your life like a nature documentary. Quietly. Mostly."],
    ],
    traits: { style: 0.45, sporty: 0.1, alternative: 0.6, polished: 0.25, humor: 0.8, sarcasm: 0.95, warmth: 0.4, ambition: 0.6, spontaneity: 0.45, nerdiness: 0.95, chaos: 0.7, nightlife: 0.35, outdoors: 0.12, fitness: 0.18, travel: 0.25, career_focus: 0.65 },
    emphasis: [
      { alternative: 0.6, nerdiness: 0.7, style: 0.4 },
      { nerdiness: 0.9, chaos: 0.6, career_focus: 0.4 },
      { sarcasm: 0.8, nerdiness: 0.8, humor: 0.6 },
      { nerdiness: 0.9, sarcasm: 0.6, chaos: 0.4 },
      { humor: 0.9, sarcasm: 0.8, chaos: 0.5 },
      { career_focus: 0.6, nerdiness: 0.6 },
    ],
  }),
  build({
    id: "sol",
    name: "Sol",
    age: 29,
    tagline: "has summited things you can't pronounce",
    job: "Wildlife biologist",
    location: "Boulder",
    captions: ["mile 19, still smiling (lying)", "alpine lake, 5:12am, no regrets"],
    prompts: [
      ["A perfect Sunday", "5am summit, burrito at the trailhead, asleep by 8. You can come if you don't mind being lapped."],
      ["I get way too excited about", "Salamanders. I have a laminated field card. I will show you the card."],
      ["Green flag", "You text 'home safe' without being asked. You also pack a spare headlamp. For me."],
    ],
    traits: { style: 0.35, sporty: 0.95, alternative: 0.2, polished: 0.3, humor: 0.55, sarcasm: 0.15, warmth: 0.82, ambition: 0.6, spontaneity: 0.6, nerdiness: 0.5, chaos: 0.25, nightlife: 0.08, outdoors: 0.98, fitness: 0.95, travel: 0.6, career_focus: 0.5 },
    emphasis: [
      { sporty: 0.9, fitness: 0.8, outdoors: 0.7 },
      { outdoors: 0.95, travel: 0.5, spontaneity: 0.4 },
      { outdoors: 0.9, fitness: 0.9, sporty: 0.6 },
      { nerdiness: 0.7, warmth: 0.5, humor: 0.5 },
      { warmth: 0.95, outdoors: 0.4 },
      { outdoors: 0.7, career_focus: 0.4 },
    ],
  }),
  build({
    id: "vivienne",
    name: "Vivienne",
    age: 31,
    tagline: "has a five-year plan for your five-year plan",
    job: "M&A associate",
    location: "Manhattan",
    captions: ["closing season, 42nd floor", "double espresso, 6:02am, on schedule"],
    prompts: [
      ["My love language", "Calendar invites. If I block time for you, that's basically a proposal."],
      ["I'm looking for", "Someone who can keep up at 6am and keep quiet at 6:05."],
      ["Two truths and a lie", "I closed a $2B deal from an airport lounge. I own one (1) pair of sneakers. I have never been late."],
    ],
    traits: { style: 0.9, sporty: 0.3, alternative: 0.05, polished: 0.98, humor: 0.4, sarcasm: 0.5, warmth: 0.35, ambition: 0.97, spontaneity: 0.1, nerdiness: 0.3, chaos: 0.05, nightlife: 0.45, outdoors: 0.12, fitness: 0.6, travel: 0.75, career_focus: 0.98 },
    emphasis: [
      { polished: 0.95, style: 0.9, career_focus: 0.5 },
      { career_focus: 0.8, polished: 0.7, ambition: 0.6 },
      { ambition: 0.8, career_focus: 0.9, humor: 0.3 },
      { ambition: 0.9, sarcasm: 0.5, fitness: 0.4 },
      { career_focus: 0.9, travel: 0.6, polished: 0.5 },
      { career_focus: 0.95, ambition: 0.8 },
    ],
  }),
  build({
    id: "kit",
    name: "Kit",
    age: 24,
    tagline: "the afterparty is wherever I'm standing",
    job: "DJ, part-time menace",
    location: "Los Angeles",
    captions: ["4am set, laundromat, iconic", "strobe hours"],
    prompts: [
      ["The last thing I did for the first time", "Played a set at 4am in a laundromat. Someone proposed. Not to me. Still counts."],
      ["Don't be mad if I", "Show up with a new haircut, a stray cat, and a one-way ticket to Seoul."],
      ["My simple pleasures", "Diner pancakes at sunrise after a night that should have ended at midnight."],
    ],
    traits: { style: 0.8, sporty: 0.2, alternative: 0.85, polished: 0.3, humor: 0.7, sarcasm: 0.5, warmth: 0.6, ambition: 0.45, spontaneity: 0.95, nerdiness: 0.3, chaos: 0.92, nightlife: 0.98, outdoors: 0.2, fitness: 0.35, travel: 0.8, career_focus: 0.25 },
    emphasis: [
      { style: 0.8, alternative: 0.85, nightlife: 0.7 },
      { nightlife: 0.95, chaos: 0.6 },
      { nightlife: 0.9, chaos: 0.8, humor: 0.5 },
      { spontaneity: 0.95, chaos: 0.9, travel: 0.6 },
      { nightlife: 0.8, warmth: 0.4, spontaneity: 0.5 },
      { nightlife: 0.8, alternative: 0.6 },
    ],
  }),
  build({
    id: "hana",
    name: "Hana",
    age: 28,
    tagline: "will remember your coffee order forever",
    job: "Kindergarten teacher",
    location: "Portland",
    captions: ["cafe window, rainy tuesday", "mugs i made (the lopsided one is my fave)"],
    prompts: [
      ["I'll fall for you if", "You remember how I take my tea. Honey. Too much honey. I know."],
      ["My most useless skill", "I can tell which of 24 five-year-olds is lying just by looking at their shoes."],
      ["Our first date", "Pottery class. You'll make an ugly bowl. I'll keep it forever."],
    ],
    traits: { style: 0.55, sporty: 0.2, alternative: 0.2, polished: 0.55, humor: 0.6, sarcasm: 0.1, warmth: 0.98, ambition: 0.35, spontaneity: 0.35, nerdiness: 0.3, chaos: 0.1, nightlife: 0.12, outdoors: 0.45, fitness: 0.3, travel: 0.35, career_focus: 0.4 },
    emphasis: [
      { warmth: 0.8, polished: 0.5, style: 0.5 },
      { warmth: 0.8, style: 0.3 },
      { warmth: 0.95 },
      { humor: 0.7, warmth: 0.6 },
      { warmth: 0.9, humor: 0.5 },
      { warmth: 0.6, career_focus: 0.3 },
    ],
  }),
  build({
    id: "zadie",
    name: "Zadie",
    age: 30,
    tagline: "will roast you with love and a microphone",
    job: "Stand-up comedian",
    location: "Chicago",
    captions: ["killing (it) on a tuesday", "my name, slightly misspelled, in lights"],
    prompts: [
      ["My therapist says", "I use humor as a defense mechanism. Joke's on her. I also use it as offense."],
      ["Biggest risk I've taken", "Telling a room of 200 dentists my honest opinion on flossing."],
      ["Dating me is like", "A roast where you are also somehow the guest of honor."],
    ],
    traits: { style: 0.6, sporty: 0.1, alternative: 0.5, polished: 0.35, humor: 0.99, sarcasm: 0.9, warmth: 0.55, ambition: 0.7, spontaneity: 0.7, nerdiness: 0.35, chaos: 0.6, nightlife: 0.75, outdoors: 0.12, fitness: 0.2, travel: 0.5, career_focus: 0.6 },
    emphasis: [
      { humor: 0.7, style: 0.6, nightlife: 0.5 },
      { nightlife: 0.7, humor: 0.6, ambition: 0.5 },
      { humor: 0.95, sarcasm: 0.9 },
      { humor: 0.9, chaos: 0.6, spontaneity: 0.5 },
      { sarcasm: 0.9, humor: 0.9, warmth: 0.3 },
      { humor: 0.7, career_focus: 0.5 },
    ],
  }),
  build({
    id: "ines",
    name: "Ines",
    age: 26,
    tagline: "currently in a timezone you've never heard of",
    job: "Travel photographer",
    location: "Lisbon, allegedly",
    captions: ["golden hour, somewhere with no wifi", "the scooter was a loan (it was not)"],
    prompts: [
      ["Most spontaneous thing I've done", "Missed a flight in Lisbon on purpose. Stayed three months. Learned to surf. Badly."],
      ["I'm convinced that", "Every city has exactly one perfect bakery and it is always next to a laundromat."],
      ["Looking for someone to", "Carry the tripod. I'll carry the conversation."],
    ],
    traits: { style: 0.75, sporty: 0.45, alternative: 0.5, polished: 0.45, humor: 0.6, sarcasm: 0.35, warmth: 0.65, ambition: 0.55, spontaneity: 0.88, nerdiness: 0.3, chaos: 0.5, nightlife: 0.5, outdoors: 0.75, fitness: 0.5, travel: 0.99, career_focus: 0.45 },
    emphasis: [
      { style: 0.7, travel: 0.8, outdoors: 0.5 },
      { travel: 0.95, spontaneity: 0.7 },
      { spontaneity: 0.95, travel: 0.9 },
      { travel: 0.7, humor: 0.5, nerdiness: 0.2 },
      { humor: 0.6, travel: 0.6, warmth: 0.4 },
      { travel: 0.8 },
    ],
  }),
  build({
    id: "wren",
    name: "Wren",
    age: 27,
    tagline: "has routes for IKEA",
    job: "Indie game developer",
    location: "Seattle",
    captions: ["build night, three monitors, zero regrets", "foam armor, weekend 1 of 1"],
    prompts: [
      ["I geek out on", "Frame data. Tea lore. The exact moment a boss fight turns into a conversation."],
      ["Unusual skill", "I can sew a full suit of armor out of foam in one weekend. Ask me why I had to."],
      ["Together we could", "Speedrun IKEA. I have routes. I have a practice cart."],
    ],
    traits: { style: 0.7, sporty: 0.15, alternative: 0.8, polished: 0.3, humor: 0.75, sarcasm: 0.45, warmth: 0.6, ambition: 0.6, spontaneity: 0.45, nerdiness: 0.97, chaos: 0.55, nightlife: 0.35, outdoors: 0.1, fitness: 0.2, travel: 0.35, career_focus: 0.55 },
    emphasis: [
      { alternative: 0.8, style: 0.7, nerdiness: 0.6 },
      { nerdiness: 0.8, alternative: 0.7 },
      { nerdiness: 0.95 },
      { nerdiness: 0.8, chaos: 0.5, humor: 0.5 },
      { humor: 0.85, nerdiness: 0.7, chaos: 0.4 },
      { nerdiness: 0.7, career_focus: 0.4 },
    ],
  }),
  build({
    id: "dahlia",
    name: "Dahlia",
    age: 29,
    tagline: "it's not a phase, it's a lifestyle subscription",
    job: "Tattoo artist",
    location: "Austin",
    captions: ["studio, 11pm, red light district of my heart", "flash sheet, available for the brave"],
    prompts: [
      ["Worst idea I've ever had", "Tattooing myself left-handed at 3am. It's a moth. It's a very confused moth."],
      ["I won't shut up about", "How gas station coffee is actually a personality test and most of you are failing."],
      ["Don't date me if", "You say 'it's just a phase.' It has been a phase since 2011."],
    ],
    traits: { style: 0.8, sporty: 0.2, alternative: 0.98, polished: 0.1, humor: 0.7, sarcasm: 0.8, warmth: 0.45, ambition: 0.5, spontaneity: 0.7, nerdiness: 0.4, chaos: 0.78, nightlife: 0.8, outdoors: 0.3, fitness: 0.3, travel: 0.4, career_focus: 0.4 },
    emphasis: [
      { alternative: 0.95, style: 0.8 },
      { alternative: 0.8, style: 0.6 },
      { chaos: 0.9, humor: 0.7, spontaneity: 0.6 },
      { sarcasm: 0.85, humor: 0.6 },
      { alternative: 0.8, sarcasm: 0.7 },
      { alternative: 0.6, nightlife: 0.5 },
    ],
  }),
  build({
    id: "priya",
    name: "Priya",
    age: 32,
    tagline: "saves lives, then crushes V6 boulders",
    job: "ER physician",
    location: "San Diego",
    captions: ["chalk is my skincare", "post-shift rooftop sunrise"],
    prompts: [
      ["I'm competitive about", "Grip strength. Crossword speed. Who clocks the fire exit first."],
      ["Typical weekend", "Night shift, bouldering gym, eleven hours of sleep, repeat."],
      ["The key to my heart", "Bring snacks. Do not ask me about your mole at dinner."],
    ],
    traits: { style: 0.45, sporty: 0.88, alternative: 0.2, polished: 0.55, humor: 0.6, sarcasm: 0.45, warmth: 0.7, ambition: 0.9, spontaneity: 0.3, nerdiness: 0.55, chaos: 0.2, nightlife: 0.15, outdoors: 0.75, fitness: 0.92, travel: 0.45, career_focus: 0.88 },
    emphasis: [
      { sporty: 0.9, fitness: 0.9 },
      { career_focus: 0.8, ambition: 0.7, warmth: 0.4 },
      { ambition: 0.8, fitness: 0.6, nerdiness: 0.4 },
      { fitness: 0.9, career_focus: 0.7 },
      { humor: 0.7, warmth: 0.5, sarcasm: 0.4 },
      { career_focus: 0.9, ambition: 0.7 },
    ],
  }),
  build({
    id: "yuki",
    name: "Yuki",
    age: 25,
    tagline: "dresses like the dress code is a suggestion",
    job: "Fashion design student",
    location: "Tokyo",
    captions: ["shibuya, 2am, editorial", "the jacket that took six weeks"],
    prompts: [
      ["My fashion hot take", "Socks with sandals, but make it architecture."],
      ["Weirdest gift I've given", "A hand-sewn jacket for a guy I met twice. He wore it to his wedding. Not to me."],
      ["I'm overly competitive about", "Thrift finds. I once fought a grandmother for a coat. Respectfully. She won."],
    ],
    traits: { style: 0.99, sporty: 0.2, alternative: 0.6, polished: 0.8, humor: 0.6, sarcasm: 0.55, warmth: 0.5, ambition: 0.75, spontaneity: 0.55, nerdiness: 0.3, chaos: 0.45, nightlife: 0.7, outdoors: 0.15, fitness: 0.4, travel: 0.65, career_focus: 0.7 },
    emphasis: [
      { style: 0.98, polished: 0.8, nightlife: 0.5 },
      { style: 0.9, ambition: 0.6 },
      { style: 0.95, humor: 0.5 },
      { humor: 0.7, warmth: 0.5, chaos: 0.4 },
      { style: 0.7, humor: 0.6, ambition: 0.4 },
      { style: 0.7, career_focus: 0.5 },
    ],
  }),
  build({
    id: "ada",
    name: "Ada",
    age: 28,
    tagline: "will explain the sky to you, gently",
    job: "Astrophysics PhD",
    location: "Tucson",
    captions: ["telescope night, 11 layers of scarf", "the dome at 3am"],
    prompts: [
      ["A shower thought I recently had", "Every photo of a star is a letter from the past. Most of my texts are also late."],
      ["I want someone who", "Will lie on a cold parking lot with me at 2am because Jupiter is up."],
      ["My most irrational fear", "Wasting our telescope time. Also geese. Mostly geese."],
    ],
    traits: { style: 0.4, sporty: 0.15, alternative: 0.45, polished: 0.4, humor: 0.65, sarcasm: 0.3, warmth: 0.78, ambition: 0.75, spontaneity: 0.4, nerdiness: 0.95, chaos: 0.3, nightlife: 0.3, outdoors: 0.6, fitness: 0.25, travel: 0.4, career_focus: 0.7 },
    emphasis: [
      { nerdiness: 0.7, warmth: 0.6, outdoors: 0.4 },
      { nerdiness: 0.9, outdoors: 0.5 },
      { nerdiness: 0.9, humor: 0.6 },
      { warmth: 0.9, spontaneity: 0.5, outdoors: 0.5 },
      { humor: 0.8, nerdiness: 0.5 },
      { nerdiness: 0.8, career_focus: 0.6 },
    ],
  }),
];
