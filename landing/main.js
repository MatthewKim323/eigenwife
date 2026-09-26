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

// under the hood: loops run only while the section is on screen
const hood = document.querySelector(".hood");
whenVisible(hood, (on) => hood.classList.toggle("live", on && !reduced), 0.05);
for (const el of document.querySelectorAll(".h-cell, .h-rule")) {
  if (reduced) el.classList.add("in");
  else whenVisible(el, (on) => on && el.classList.add("in"), 0.35);
}

// memory feed: a new row lands on top, the oldest falls off
const svg = (d) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const FI = {
  pref: svg('<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"/>'),
  ep: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 12v6M9 15h6"/>'),
  rel: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>'),
  gaze: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
};
const FEED = [
  ["pref", "Preference updated", "likes spicy · 0.94"],
  ["ep", "Episode stored", "$28 ramen was overpriced"],
  ["rel", "Relationship shifted", "banter +0.03"],
  ["gaze", "Attention target", "Hellfire Tantanmen · 2.8s"],
  ["link", "Task linked", "calendar · tonight 7:30"],
  ["ep", "Episode stored", "4th replay of the breakup song"],
  ["pref", "Preference updated", "saving money · 0.83"],
];
const AGO = ["just now", "12s ago", "28s ago", "1m ago", "2m ago"];
const feed = document.getElementById("feed");
let fk = 0;
const feedRows = [];
function renderFeed() {
  feed.innerHTML = feedRows
    .map(([ic, what, src], i) => `<div class="f-row"${i ? ' style="animation:none"' : ""}><i>${FI[ic]}</i><div><p class="f-what">${what}</p><p class="f-src">${src}</p></div><p class="f-when"><span class="h-ping"></span>${AGO[i]}</p></div>`)
    .join("");
}
for (let i = 0; i < 5; i++) feedRows.push(FEED[(FEED.length - 1 - i) % FEED.length]);
renderFeed();
let feedTimer = null;
function pushFeed() {
  feedRows.unshift(FEED[fk++ % FEED.length]);
  feedRows.length = 5;
  renderFeed();
  feedTimer = setTimeout(pushFeed, 2600);
}
if (!reduced) whenVisible(feed, (on) => { clearTimeout(feedTimer); if (on) feedTimer = setTimeout(pushFeed, 1200); });

// plan chain: the swarm visits each branch, rests, repeats
const nodes = [...document.querySelectorAll("#chain .ch-node")];
let ck = 0, chainTimer = null;
function stepChain() {
  nodes.forEach((n, i) => n.classList.toggle("on", i === ck));
  const rest = ck === nodes.length - 1 ? 2400 : 700;
  ck = (ck + 1) % nodes.length;
  chainTimer = setTimeout(stepChain, rest);
}
if (reduced) nodes[2].classList.add("on");
else whenVisible(document.getElementById("chain"), (on) => { clearTimeout(chainTimer); if (on) stepChain(); });
