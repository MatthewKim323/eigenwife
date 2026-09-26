/**
 * One-shot art generator for the demo. Stylized anime illustrations of
 * fictional adults (never photoreal), plus menu food art.
 *
 *   OPENAI_API_KEY=... bun apps/shell/src/data/gen-art.ts [--only mira,sol] [--menu] [--force]
 *
 * Writes webp files into apps/shell/public/{candidates,menu}/. Needs `cwebp`.
 * Skips files that already exist unless --force.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MENU } from "./menu";

const MODEL = process.env.IMAGE_MODEL ?? "gpt-image-2";
const PUBLIC = join(import.meta.dir, "../../public");

const STYLE =
  "Modern anime key-visual illustration, soft cel shading, delicate clean linework, dreamy diffuse lighting, subtle film grain, " +
  "muted pastel palette with lavender and periwinkle ambient tones, gentle bloom. Clearly a fictional illustrated character, " +
  "an adult in their late twenties. Not photorealistic. No text, no logos, no watermark, no border.";

const PEOPLE: Record<string, [string, string]> = {
  mira: [
    "Dating-profile portrait of a woman with a sharp black bob and round wire glasses, oversized charcoal hoodie, holding a soldering iron with a tiny curl of smoke, smirking at the viewer, dim desk lamp glow, circuit boards blurred behind her.",
    "A cluttered night workbench seen from above: green circuit boards, oscilloscope glow, tangled wires, a black cat asleep on a keyboard, mug of cold coffee, warm lamp light.",
  ],
  sol: [
    "Dating-profile portrait of a sun-kissed woman with a long dark braid and freckles, trail-running vest and cap, grinning mid-run on a ridge, dramatic mountains and morning light behind her.",
    "An alpine lake at dawn with a small orange tent on the shore, mist over the water, jagged peaks glowing pink, trail-running shoes drying on a rock.",
  ],
  vivienne: [
    "Dating-profile portrait of a poised woman with a sleek low bun and tailored ivory blazer, pearl earrings, cool confident half-smile, floor-to-ceiling window with a city skyline at dusk behind her.",
    "A marble cafe table with a double espresso, a leather planner full of neat color-coded notes, a fountain pen, and a phone showing a calendar, early morning window light.",
  ],
  kit: [
    "Dating-profile portrait of a playful woman with a messy pink-streaked wolf cut, over-ear headphones around her neck, iridescent holographic jacket, winking, neon magenta and cyan club lights.",
    "A DJ booth from behind the decks at 4am: glowing controller, blurred crowd silhouettes, strobe beams cutting through haze, confetti in the air.",
  ],
  hana: [
    "Dating-profile portrait of a gentle woman with soft wavy chestnut hair and a cream knit cardigan, warm shy smile, holding a cup of tea by a rainy cafe window, cozy golden light.",
    "A wooden shelf of handmade ceramic mugs and bowls in soft glazes, one charmingly lopsided, plants and afternoon sun, a pottery wheel blurred in the background.",
  ],
  zadie: [
    "Dating-profile portrait of a woman with big curly copper-red hair and a black leather jacket, laughing mid-joke into a vintage microphone, single warm spotlight, brick wall behind her.",
    "A small comedy club exterior at night with a glowing marquee of blank letter tiles, rain-slick street reflecting red and gold light, a line of people under umbrellas.",
  ],
  ines: [
    "Dating-profile portrait of a woman with windswept honey-brown hair and a linen shirt, film camera raised halfway, squinting into golden-hour sun on a coastal cliff, ocean behind her.",
    "A narrow sunlit Mediterranean street with a mint-green scooter parked by a bakery with pastries in the window, laundry lines overhead, warm afternoon light.",
  ],
  wren: [
    "Dating-profile portrait of a woman with silver hair in two space buns, techwear jacket with glowing trim, holding a game controller, grinning, lit by the blue glow of three monitors.",
    "A crafting workbench covered in foam armor pieces, a heat gun, patterns and a half-finished fantasy helmet, fairy lights and a monitor showing a pixel-art game.",
  ],
  dahlia: [
    "Dating-profile portrait of a woman with a black undercut and septum piercing, illustrated tattoo sleeves of moths and flowers, dry unimpressed smirk, moody red neon studio light.",
    "A tattoo artist's flash sheet pinned on a wall: moths, daggers, roses, a very confused moth in the center, ink bottles and a red neon sign glow.",
  ],
  priya: [
    "Dating-profile portrait of an athletic woman with a high ponytail and chalky hands, sports top, determined grin, hanging from a colorful bouldering wall, bright gym lighting.",
    "A hospital rooftop at sunrise, a woman's hand in teal scrubs holding a paper coffee cup against a sky of pink clouds, city waking up below.",
  ],
  yuki: [
    "Dating-profile editorial portrait of a stylish woman with long straight black hair and an avant-garde layered asymmetric outfit, cool gaze over her shoulder, rainy Tokyo crossing at night with neon signs.",
    "A fashion studio corner: a dress form wearing a half-finished sculptural jacket, fabric swatches pinned to a board, scissors and chalk, soft window light.",
  ],
  ada: [
    "Dating-profile portrait of a woman with messy auburn hair and a huge knitted scarf, freckles, wonder in her eyes, looking up at a sky full of stars next to a small telescope.",
    "An observatory dome open to the milky way at 3am, a thermos and notebook on a railing, deep blue and violet night sky, soft red flashlight glow.",
  ],
};

const DISHES: Record<string, string> = {
  "garlic-knockout": "A steaming bowl of rich creamy tonkotsu ramen with swirls of black garlic oil, sliced chashu pork, a jammy soft-boiled egg, scallions, nori.",
  "a5-wagyu": "A luxurious bowl of clear golden shoyu ramen topped with seared marbled wagyu slices, a dot of green yuzu kosho, shaved truffle, fine noodles, in a black lacquer bowl.",
  tantanmen: "A fiery red bowl of tantanmen ramen with sesame chili broth, ground spicy pork, bok choy, chili oil pooling, steam rising dramatically.",
  "yuzu-shio": "A light clear chicken shio ramen with yuzu peel, pale chicken chashu, mizuna greens, delicate and bright, in a white ceramic bowl.",
  "miso-veggie": "A bowl of orange spicy miso vegan ramen with charred corn, golden tofu cubes, chili threads, scallions, creamy broth.",
  karaage: "A plate of crispy Japanese karaage fried chicken glazed with glossy black garlic sauce, shichimi mayo drizzle, lemon wedge, on a small ceramic plate.",
};

const FOOD_STYLE =
  "Anime food illustration in the style of a cozy animated film, glossy appetizing highlights, soft steam, warm moody late-night ramen shop lighting, dark wood counter, shallow depth of field, top-three-quarter angle. No text, no logos, no watermark.";

async function generate(prompt: string, size: string, out: string): Promise<boolean> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY missing");
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, size, quality: "medium", n: 1 }),
    });
    if (!res.ok) {
      console.warn(`[art] ${out} attempt ${attempt}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      await Bun.sleep(2000 * attempt);
      continue;
    }
    const json = (await res.json()) as { data: { b64_json: string }[] };
    const png = `${out}.png`;
    await Bun.write(png, Buffer.from(json.data[0]!.b64_json, "base64"));
    const cw = Bun.spawnSync(["cwebp", "-quiet", "-q", "80", "-resize", size.startsWith("1024x1536") ? "768" : "640", "0", png, "-o", out]);
    await Bun.$`rm -f ${png}`.quiet();
    if (cw.exitCode !== 0) {
      console.warn(`[art] cwebp failed for ${out}`);
      return false;
    }
    console.log(`[art] wrote ${out}`);
    return true;
  }
  return false;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<unknown>) {
  const q = [...items];
  await Promise.all(Array.from({ length: n }, async () => {
    while (q.length) await fn(q.shift()!);
  }));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1]!.split(",")) : null;
  const doMenu = args.includes("--menu") || !only;
  mkdirSync(join(PUBLIC, "candidates"), { recursive: true });
  mkdirSync(join(PUBLIC, "menu"), { recursive: true });

  const jobs: { prompt: string; size: string; out: string }[] = [];
  for (const [id, [portrait, scene]] of Object.entries(PEOPLE)) {
    if (only && !only.has(id)) continue;
    jobs.push({ prompt: `${portrait} ${STYLE}`, size: "1024x1536", out: join(PUBLIC, "candidates", `${id}-1.webp`) });
    jobs.push({ prompt: `${scene} ${STYLE.replace(/an adult in their late twenties\. /, "")}`, size: "1024x1536", out: join(PUBLIC, "candidates", `${id}-2.webp`) });
  }
  if (doMenu) for (const d of MENU) jobs.push({ prompt: `${DISHES[d.id]} ${FOOD_STYLE}`, size: "1024x1024", out: join(PUBLIC, "menu", `${d.id}.webp`) });

  const todo = jobs.filter((j) => force || !existsSync(j.out));
  console.log(`[art] ${todo.length} images with ${MODEL}`);
  await pool(todo, 5, (j) => generate(j.prompt, j.size, j.out));
}
