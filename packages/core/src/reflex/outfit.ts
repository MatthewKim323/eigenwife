/**
 * Spoken outfit requests: "put your hoodie on", "hood up", "lose the shades",
 * "take it off", "what are you wearing", "wear a dress". Keyword based like
 * intent.ts, well under 1ms. Outfits only change when the user asks.
 * Item ids are the protocol wardrobe catalog (packages/protocol/src/wardrobe.ts).
 */

export type OutfitIntent =
  | { kind: "wear"; add: string[] }
  | { kind: "remove"; remove: string[] | "all" }
  /** "change clothes": no item named, she picks (hoodie on, or back to normal). */
  | { kind: "change" }
  | { kind: "ask" }
  /** Asked for something she doesn't have. */
  | { kind: "missing"; want: string };

const ASK =
  /\bwhat(?:'?s| is| are|'?re)? (?:you|u|ya) (?:wearing|got on|have on)\b|\bwhat do (?:you|u) have on\b|\bwhat(?:'?s| is) (?:your|ur) (?:outfit|fit)\b|\bwhat (?:can|could) (?:you|u) wear\b|\bwhat (?:outfits|clothes) do (?:you|u) have\b/i;
const REMOVE_ALL =
  /^(?:(?:eve|ok(?:ay)?|now|yo|hey)[, ]+)?(?:take (?:it|that|them|everything|it all) off|(?:go |change |switch )?back to (?:normal|your usual|your normal clothes|regular)|(?:put on |wear )?(?:your )?(?:normal|regular|usual) (?:clothes|outfit|look)|change back|undress the outfit)\b/i;
const CHANGE = /\b(?:change (?:your )?(?:clothes|outfit)|(?:new|different) outfit|switch (?:it|your look) up|get changed)\b/i;

/** Item patterns, most specific first (hood up before hoodie, shades up before shades). */
const ITEMS: [string, RegExp][] = [
  ["hood_up", /\bhood(?:ie)? up\b|\bput (?:your |the )?hood up\b|\bhood on\b|\bput (?:your |the )?hood on\b/i],
  ["hoodie", /\bhood down\b|\bhoodie\b|\bhoody\b|\bpajamas\b|\bpyjamas\b|\bpjs?\b|\bjammies\b|\bcomfy\b|\bcozy\b|\bcosy\b|\bcomfortable clothes\b|\bsweatshirt\b|\bsweater\b|\bcat hoodie\b/i],
  ["sunglasses_up", /\b(?:push|put|move|flip|slide) (?:your |the |those )?(?:sun)?(?:glasses|shades|sunnies) up\b|\b(?:sun)?(?:glasses|shades|sunnies) up\b|\b(?:glasses|shades) on (?:your|ur) head\b/i],
  ["sunglasses", /\bsunglasses\b|\bshades\b|\bsunnies\b|\bglasses\b|\bspecs\b/i],
  ["lollipop", /\blollipop\b|\blolly\b|\blollies\b|\bcandy\b|\bsucker\b/i],
  ["odd_eye_right", /\b(?:right|other) eye (?:purple|violet)\b|\b(?:purple|violet) right eye\b/i],
  ["odd_eye_left", /\bheterochromia\b|\b(?:odd|different|two|mismatched)[- ](?:colou?red )?eyes?\b|\b(?:purple|violet) (?:left )?eye\b|\bodd eye\b/i],
];

const NORMAL_EYES = /\b(?:normal|regular|matching|same colou?r) eyes\b/i;

/** Things people might ask for that she doesn't have. */
const MISSING =
  /\b(dress|skirt|bikini|swimsuit|kimono|tuxedo|tux|suit|uniform|maid outfit|costume|hat|cap|beanie|crown|tiara|jacket|coat|scarf|necklace|earrings|heels|boots|sneakers|shoes|pajama pants|onesie|jersey|apron)\b/i;

const WEAR_VERB =
  /\b(?:put (?:on|your|the|some|a|an)|wear(?:ing)?|throw on|try on|rock|change into|switch (?:to|into)|slip (?:on|into)|go with|get comfy|get cozy|dress up|have (?:a|an|some|your)|eat (?:a|an|your))\b|\bon\s*[.!?]*$/i;
const REMOVE_VERB = /\b(?:take (?:off|out)|lose|ditch|remove|no more|get rid of|drop|without|stop wearing|put away)\b|\boff\s*[.!?]*$/i;

/** Parse an utterance. null = not about her outfit. */
export function readOutfit(text: string): OutfitIntent | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const words = t.split(/\s+/).length;
  if (words > 14) return null;
  if (ASK.test(t)) return { kind: "ask" };
  if (NORMAL_EYES.test(t)) return { kind: "remove", remove: ["odd_eye_left", "odd_eye_right"] };
  if (REMOVE_ALL.test(t) && !/\b(?:calendar|list|schedule|tab|page|app)\b/.test(t)) return { kind: "remove", remove: "all" };
  const items: string[] = [];
  for (const [id, re] of ITEMS) {
    if (!re.test(t)) continue;
    // "shades up" also says "shades": the specific one wins inside a family.
    if (id === "sunglasses" && items.includes("sunglasses_up")) continue;
    if (id === "hoodie" && items.includes("hood_up") && !/\bhood down\b/.test(t)) continue;
    if (id === "odd_eye_left" && items.includes("odd_eye_right")) continue;
    items.push(id);
  }
  const remove = REMOVE_VERB.test(t);
  const wear = WEAR_VERB.test(t);
  // "hood up/down", "shades up", "get comfy" carry their own verb.
  const selfVerb = /\bhood (?:up|down|on)\b|\b(?:glasses|shades|sunnies) up\b|\bget (?:comfy|cozy)\b|\bcozy clothes\b|\bcomfy clothes\b/.test(t);
  if (items.length) {
    if (remove && !/\bhood down\b/.test(t)) {
      // "take the hoodie off": both hoodie variants come off.
      const out = items.flatMap((id) => (id === "hoodie" || id === "hood_up" ? ["hoodie", "hood_up"] : id === "sunglasses" || id === "sunglasses_up" ? ["sunglasses", "sunglasses_up"] : id.startsWith("odd_eye") ? ["odd_eye_left", "odd_eye_right"] : [id]));
      return { kind: "remove", remove: [...new Set(out)] };
    }
    if (wear || selfVerb) return { kind: "wear", add: items };
    return null;
  }
  const miss = MISSING.exec(t);
  if (miss && wear && /\b(?:you|your|u|ur|yourself)\b|^(?:put|wear|throw|try|change|slip)\b/.test(t)) return { kind: "missing", want: miss[1]! };
  if (CHANGE.test(t)) return { kind: "change" };
  return null;
}
