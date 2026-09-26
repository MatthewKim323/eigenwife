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
const verdictRows = [document.querySelectorAll(".v"), document.querySelectorAll(".viz-reflex span")];
setInterval(() => {
  for (const row of verdictRows) {
    const i = Math.random() < 0.85 ? 0 : 1 + Math.floor(Math.random() * (row.length - 1));
    row.forEach((v, j) => v.classList.toggle("on", j === i));
  }
}, 1100);

// uptime keeps counting
const ups = [document.getElementById("uptime"), ...document.querySelectorAll("[data-uptime]")];
let secs = 5 * 3600 + 31 * 60 + 14;
setInterval(() => {
  secs++;
  const h = String(Math.floor(secs / 3600)).padStart(2, "0");
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  for (const up of ups) up.textContent = `${h}:${m}:${s}`;
}, 1000);

// Run a callback only while an element is on screen and the tab is visible.
function whenVisible(el, onChange, threshold = 0.3) {
  let seen = false;
  const update = () => onChange(seen && !document.hidden);
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; update(); }, { threshold }).observe(el);
  document.addEventListener("visibilitychange", update);
}

// bento diagrams animate only on screen
const bento = document.querySelector(".bento");
whenVisible(bento, (on) => bento.classList.toggle("in", on && !reduced), 0.1);

// odometer: each digit rolls, no tweened counting
for (const el of document.querySelectorAll("[data-odo]")) {
  const text = el.dataset.odo;
  el.innerHTML =
    [...text].map((ch) => (/\d/.test(ch) ? `<span class="odo"><span>${[...Array(10).keys()].join("<br>")}</span></span>` : ch)).join("") +
    (el.dataset.suffix || "");
  const reels = [...el.querySelectorAll(".odo > span")];
  const digits = [...text].filter((c) => /\d/.test(c)).map(Number);
  const roll = () => reels.forEach((r, i) => {
    r.style.transitionDelay = `${i * 90}ms`;
    r.style.transform = `translateY(${-digits[i]}em)`;
  });
  if (reduced) roll();
  else whenVisible(el, (on) => on && roll(), 0.6);
}

// self-driving chat: fixed beats, pauses off screen, resumes on the same beat
const chat = document.getElementById("chat");
const BEATS = [900, 2400, 3200, 3000, 3800];
let beat = 0, beatTimer = null, chatOn = false;
function nextBeat() {
  beatTimer = setTimeout(() => {
    beat = (beat + 1) % BEATS.length;
    chat.dataset.phase = String(beat);
    if (chatOn) nextBeat();
  }, BEATS[beat]);
}
if (reduced) chat.dataset.phase = "4";
else whenVisible(chat, (on) => {
  chatOn = on;
  clearTimeout(beatTimer);
  if (on) nextBeat();
});

// terminal transcript in the reasoning cell
const term = document.getElementById("term");
const TERM = [
  ['<span class="p">jabby</span> escalate <span class="dim">"figure out tonight"</span>', 700],
  ['<span class="dim">router</span> COMPLEX_REASONING -> claude', 600],
  ['<span class="dim">plan</span> calendar.free(tonight) · places.search(cheap, spicy)', 900],
  ['<span class="dim">memory</span> hit: "$28 ramen was overpriced" (0.89)', 800],
  ['<span class="dim">gate</span> calendar.create -> ask user · <span class="ok">approved</span>', 900],
  ['<span class="ok">done</span> 7:30 PM · Menya Kaze · $14', 2600],
];
let tl = 0, termTimer = null;
function termStep() {
  if (tl === 0) term.innerHTML = "";
  const [line, ms] = TERM[tl];
  term.insertAdjacentHTML("beforeend", `<div>${line}</div>`);
  tl = (tl + 1) % TERM.length;
  termTimer = setTimeout(termStep, ms);
}
if (reduced) { TERM.forEach(([l]) => term.insertAdjacentHTML("beforeend", `<div>${l}</div>`)); }
else whenVisible(term, (on) => { clearTimeout(termTimer); if (on) termStep(); });
