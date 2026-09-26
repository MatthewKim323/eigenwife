// eigenwife landing: real clips, the compile-your-type toy, and a few live diagnostics.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Clips play only while on screen (and not at all with reduced motion).
const clips = [...document.querySelectorAll("video.clip")];
if (reduced) clips.forEach((v) => v.removeAttribute("autoplay"));
else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.play().catch(() => {});
        else e.target.pause();
      }
    },
    { threshold: 0.35 },
  );
  clips.forEach((v) => io.observe(v));
}

// compile your type: hover dwell is the attention reward
const TRAITS = ["humor", "sarcasm", "warmth", "chaos", "nerdiness", "ambition"];
const CANDIDATES = [
  {
    name: "Mika, 24",
    prompt: "my most controversial opinion: tabs > spaces",
    icon: "i-vec",
    bg: "var(--lilac)",
    v: { humor: 0.7, sarcasm: 0.92, warmth: 0.4, chaos: 0.5, nerdiness: 0.95, ambition: 0.7 },
  },
  {
    name: "Juno, 26",
    prompt: "looking for someone to split a $21 ramen with",
    icon: "i-ramen",
    bg: "var(--butter)",
    v: { humor: 0.85, sarcasm: 0.4, warmth: 0.9, chaos: 0.3, nerdiness: 0.35, ambition: 0.45 },
  },
  {
    name: "Rae, 25",
    prompt: "will absolutely book a flight at 2am",
    icon: "i-spark",
    bg: "var(--mint)",
    v: { humor: 0.75, sarcasm: 0.6, warmth: 0.55, chaos: 0.95, nerdiness: 0.3, ambition: 0.85 },
  },
];
const LINES = {
  humor: "you just want someone who laughs at your bits. I can do that.",
  sarcasm: "oh great. you like being roasted. this will be easy.",
  warmth: "you kept looking at the nice one. that's kind of adorable.",
  chaos: "you have a type and it's 'questionable decisions.' hi.",
  nerdiness: "you lingered on the tabs guy. we're gonna argue about vim.",
  ambition: "you like people with plans. good, I have several.",
};
const FULL_MS = 7000; // total attention needed to converge

const profilesEl = document.getElementById("profiles");
const traitsEl = document.getElementById("traits");
const meter = document.getElementById("meter");
const pct = document.getElementById("pct");
const heroPct = document.getElementById("hero-pct");
const converged = document.getElementById("converged");
const say = document.getElementById("converged-say");

const dwell = CANDIDATES.map(() => 0);
let looking = -1;
let done = false;

CANDIDATES.forEach((c, i) => {
  const card = document.createElement("article");
  card.className = "profile sticker-card";
  card.innerHTML = `
    <div class="pfp" style="background:${c.bg}"><svg><use href="#${c.icon}"/></svg><span class="gaze-ring"></span></div>
    <h4>${c.name}</h4>
    <p class="prompt">${c.prompt}</p>
    <p class="dwell mono" data-dwell>0.0s</p>`;
  card.addEventListener("pointerenter", () => (looking = i));
  card.addEventListener("pointerleave", () => looking === i && (looking = -1));
  card.addEventListener("pointerdown", () => (looking = i)); // touch: tap to look
  profilesEl.append(card);
});
const cards = [...profilesEl.children];

traitsEl.innerHTML = TRAITS.map(
  (t) => `<div class="trait mono"><span>${t}</span><span class="bar"><i data-t="${t}"></i></span><b data-v="${t}">.50</b></div>`,
).join("");

function model() {
  const total = dwell.reduce((a, b) => a + b, 0);
  const p = {};
  for (const t of TRAITS) {
    // P = sum(r_i * C_i) / sum(r_i), starting from a neutral prior
    const prior = 400;
    p[t] = (prior * 0.5 + CANDIDATES.reduce((s, c, i) => s + dwell[i] * c.v[t], 0)) / (prior + total);
  }
  return { p, total };
}

let last = performance.now();
function tick(now) {
  const dt = Math.min(now - last, 100);
  last = now;
  if (!done && looking >= 0) dwell[looking] += dt;
  cards.forEach((c, i) => {
    c.classList.toggle("looking", i === looking && !done);
    c.querySelector("[data-dwell]").textContent = `${(dwell[i] / 1000).toFixed(1)}s`;
  });
  const { p, total } = model();
  const progress = Math.min(total / FULL_MS, 1);
  meter.style.width = `${progress * 100}%`;
  pct.textContent = done ? "98% · EIGENWOMAN FOUND" : `${Math.round(progress * 98)}%`;
  for (const t of TRAITS) {
    traitsEl.querySelector(`[data-t="${t}"]`).style.width = `${p[t] * 100}%`;
    traitsEl.querySelector(`[data-v="${t}"]`).textContent = p[t].toFixed(2).slice(1);
  }
  if (!done && progress >= 1) {
    done = true;
    looking = -1;
    // the trait the user pulled furthest from neutral
    const top = TRAITS.reduce((a, b) => (Math.abs(p[b] - 0.5) > Math.abs(p[a] - 0.5) ? b : a));
    say.textContent = LINES[top];
    converged.hidden = false;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

document.getElementById("recompile").addEventListener("click", () => {
  dwell.fill(0);
  done = false;
  converged.hidden = true;
});

// hero chip creeps up like the model is learning you
let hp = 31;
setInterval(() => {
  hp = hp >= 98 ? 31 : hp + 1 + Math.round(Math.random() * 3);
  heroPct.textContent = Math.min(hp, 98);
}, 900);

// reflex layer: mostly IGNORE, sometimes not
const verdicts = [...document.querySelectorAll(".v")];
setInterval(() => {
  const r = Math.random();
  const i = r < 0.85 ? 0 : 1 + Math.floor(Math.random() * (verdicts.length - 1));
  verdicts.forEach((v, j) => v.classList.toggle("on", j === i));
}, 1100);

// uptime keeps counting
const up = document.getElementById("uptime");
let secs = 5 * 3600 + 31 * 60 + 14;
setInterval(() => {
  secs++;
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  up.textContent = `${h}:${m}:${s}`;
}, 1000);
