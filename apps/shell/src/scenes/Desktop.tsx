import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { CANDIDATES, type GazeTarget } from "@eigenwife/protocol";
import { Ambient, useNow } from "../components/fx";
import { ArtImage, FoodArt } from "../components/GenArt";
import { ProfileCard } from "../components/ProfileCard";
import { MENU, RESTAURANT, type Dish } from "../data/menu";
import { gazeProps } from "../gaze/tracker";
import { useBus } from "../lib/bus";
import { useShell, type ShellState } from "../lib/store";
import "../styles/desktop.css";

/** Eve's home screen. The right ~420px stays calm: that's where she lives. */
export function DesktopScene() {
  return (
    <div className="desk">
      <Wallpaper />
      <MenuBar />
      <BrowserWindow />
      <CalendarWidget />
      <ResultCard />
      <Dock />
      <EigenWindow />
    </div>
  );
}

function Wallpaper() {
  return (
    <Ambient>
      <div className="wall-rings" />
      <div className="wall-word">eigen</div>
    </Ambient>
  );
}

// ---------------------------------------------------------------------------

function MenuBar() {
  const now = useNow(1000);
  const home = useShell((s) => s.home);
  const persona = useShell((s) => s.persona);
  const time = new Date(now).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const date = new Date(now).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return (
    <div className="menubar">
      <span className="logo">◐</span>
      <b>Eigen OS</b>
      <span className="dim">File</span>
      <span className="dim">View</span>
      <span className="dim">Window</span>
      <span className="grow" />
      <HomeChip home={home} now={now} name={persona?.name ?? "Eve"} />
      <span className="dim">{date}</span>
      <span>{time}</span>
    </div>
  );
}

function HomeChip({ home: h, now, name }: { home: ShellState["home"]; now: number; name: string }) {
  const up = h ? h.uptimeMs + (h.online ? now - h.ts : 0) : 0;
  return (
    <span className={`home-chip ${h?.online ? "on" : ""}`} {...gazeProps("home-status", `${name} home status`, "ui", h ? { host: h.host, memories: h.memories, tasks: h.tasks } : undefined)}>
      <span className="who">{name.toUpperCase()}</span>
      <span className="lamp" />
      <span>{h ? (h.online ? "STATUS ONLINE" : "OFFLINE") : "HOME ..."}</span>
      {h && (
        <>
          <span className="sep">|</span>
          <span>UPTIME {fmtUptime(up)}</span>
          <span className="sep">|</span>
          <span>MEMORIES {h.memories}</span>
          <span className="sep">|</span>
          <span>TASKS {h.tasks}</span>
        </>
      )}
    </span>
  );
}

export function fmtUptime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// ---------------------------------------------------------------------------
// Browser + restaurant page
// ---------------------------------------------------------------------------

function dishTarget(d: Dish): GazeTarget {
  return {
    key: `menu_${d.id}`,
    label: `${d.name}, $${d.price}, ${d.rating} stars, spice ${d.spice}/5, ${RESTAURANT.name}`,
    kind: "menu-item",
    meta: { name: d.name, price: d.price, spice: d.spice, rating: d.rating, reviews: d.reviews, restaurant: RESTAURANT.name, tags: d.tags },
  };
}

function pageMarkdown(): string {
  return [
    `# ${RESTAURANT.name} (${RESTAURANT.kana})`,
    `${RESTAURANT.tagline}. ${RESTAURANT.rating} stars, ${RESTAURANT.reviews} reviews. ${RESTAURANT.priceLevel}. ${RESTAURANT.hours}. ${RESTAURANT.address}.`,
    "",
    "## Menu",
    ...MENU.map((d) => `- **${d.name}** $${d.price} · spice ${d.spice}/5 · ${d.rating} stars (${d.reviews}) · ${d.blurb}`),
  ].join("\n");
}

function BrowserWindow() {
  const { emit } = useBus();
  const targets = useMemo(() => MENU.map(dishTarget), []);
  useEffect(() => {
    emit("page.context", {
      url: RESTAURANT.url,
      title: `${RESTAURANT.name} · Menu`,
      targets: [
        { key: "restaurant_header", label: `${RESTAURANT.name}, ${RESTAURANT.rating} stars, ${RESTAURANT.priceLevel}`, kind: "restaurant", meta: { ...RESTAURANT } },
        ...targets,
      ],
      markdown: pageMarkdown(),
    });
    emit("app.focused", { app: "Browser", title: `${RESTAURANT.name} · Menu` });
  }, [emit, targets]);

  return (
    <motion.section
      className="browser"
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: "spring", duration: 0.7, bounce: 0, delay: 0.1 }}
    >
      <div className="chrome">
        <span className="lights">
          <i />
          <i />
          <i />
        </span>
        <span className="tab">
          <span className="fav">月</span>
          {RESTAURANT.name} · Menu
        </span>
        <span className="url mono">
          <span className="lock">⌾</span> {RESTAURANT.url.replace("https://", "")}
        </span>
      </div>
      <div className="page">
        <header className="rest-head" {...gazeProps("restaurant_header", `${RESTAURANT.name}, ${RESTAURANT.rating} stars`, "restaurant", { ...RESTAURANT })}>
          <div>
            <div className="kana">{RESTAURANT.kana}</div>
            <h1>{RESTAURANT.name}</h1>
            <div className="meta mono">
              ★ {RESTAURANT.rating} · {RESTAURANT.reviews.toLocaleString()} reviews · {RESTAURANT.priceLevel} · {RESTAURANT.hours}
            </div>
          </div>
          <div className="tag">{RESTAURANT.tagline}</div>
        </header>
        <div className="menu-grid">
          {MENU.map((d, i) => (
            <MenuCard key={d.id} d={d} i={i} />
          ))}
        </div>
      </div>
    </motion.section>
  );
}

function MenuCard({ d, i }: { d: Dish; i: number }) {
  const t = dishTarget(d);
  return (
    <motion.article
      className="dish"
      {...gazeProps(t.key, t.label, "menu-item", t.meta)}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", duration: 0.6, bounce: 0, delay: 0.25 + i * 0.05 }}
    >
      <div className="dish-img">
        <ArtImage src={d.img} alt={d.name} className="art" fallback={<FoodArt id={d.id} className="art" />} />
        {d.tags.includes("premium") && <span className="badge">premium</span>}
        {d.tags.includes("signature") && <span className="badge sig">signature</span>}
      </div>
      <div className="dish-body">
        <div className="row">
          <h3>{d.name}</h3>
          <span className="price">${d.price}</span>
        </div>
        <div className="jp">{d.jp}</div>
        <p>{d.blurb}</p>
        <div className="row small mono">
          <span className="spice" aria-label={`spice ${d.spice} of 5`}>
            {Array.from({ length: 5 }, (_, k) => (
              <i key={k} className={k < d.spice ? "on" : ""} />
            ))}
          </span>
          <span>
            ★ {d.rating} <span className="dim">({d.reviews})</span>
          </span>
        </div>
      </div>
    </motion.article>
  );
}

// ---------------------------------------------------------------------------
// Calendar, result, dock, Eigen app
// ---------------------------------------------------------------------------

function CalendarWidget() {
  const events = useShell((s) => s.calendar);
  const now = useNow(30_000);
  const d = new Date(now);
  return (
    <div className={`cal ${events.length ? "has" : ""}`} {...gazeProps("calendar_widget", "calendar: today's events", "ui", { events: events.map((e) => `${e.when} ${e.title}`) })}>
      <div className="cal-date">
        <span className="dow mono">{d.toLocaleDateString([], { weekday: "short" }).toUpperCase()}</span>
        <b>{d.getDate()}</b>
      </div>
      <div className="cal-list">
        {events.length === 0 && <div className="empty">Nothing tonight. Suspicious.</div>}
        <AnimatePresence initial={false}>
          {events.slice(-3).map((e) => (
            <motion.div
              key={e.id}
              className="cal-ev"
              initial={{ opacity: 0, y: 10, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ type: "spring", duration: 0.6, bounce: 0.15 }}
            >
              <span className="when mono">{e.when}</span>
              <span className="what">{e.title}</span>
              {e.where && <span className="where">{e.where}</span>}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function ResultCard() {
  const result = useShell((s) => s.result);
  const now = useNow(1000);
  const show = !!result && now - result.ts < 20_000;
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key={result!.taskId}
          className={`result ${result!.ok ? "" : "bad"}`}
          initial={{ opacity: 0, x: 24, scale: 0.97 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 24, transition: { duration: 0.2 } }}
          transition={{ type: "spring", duration: 0.6, bounce: 0.1, delay: 0.5 }}
          {...gazeProps("task_result", `task result: ${result!.summary}`, "ui")}
        >
          <div className="k mono">{result!.ok ? "TASK COMPLETE" : "TASK FAILED"}</div>
          <div className="s">{result!.summary}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

const DOCK = [
  { id: "browser", label: "Browser", glyph: "◎", hue: 220 },
  { id: "calendar", label: "Calendar", glyph: "▦", hue: 20 },
  { id: "notes", label: "Notes", glyph: "✎", hue: 85 },
  { id: "music", label: "Music", glyph: "♪", hue: 340 },
  { id: "eigen", label: "Eigen", glyph: "e", hue: 330 },
];

function Dock() {
  const eigenOpen = useShell((s) => s.eigenOpen);
  return (
    <nav className="dock">
      {DOCK.map((a) => (
        <div
          key={a.id}
          className={`dock-app ${a.id === "eigen" ? "eigen" : ""} ${(a.id === "eigen" && eigenOpen) || a.id === "browser" ? "running" : ""}`}
          {...gazeProps(`dock_${a.id}`, `${a.label} app icon`, "app", { app: a.label })}
        >
          <span className="icon" style={{ ["--ih" as string]: a.hue }}>
            {a.glyph}
          </span>
          <span className="name">{a.label}</span>
        </div>
      ))}
    </nav>
  );
}

function EigenWindow() {
  const open = useShell((s) => s.eigenOpen);
  const c = CANDIDATES.find((x) => x.id === "kit")!;
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="eigen-win"
          initial={{ opacity: 0, y: 40, scale: 0.94, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: 60, scale: 0.9, rotate: -2, filter: "blur(8px)", transition: { duration: 0.32, ease: [0.4, 0, 1, 1] } }}
          transition={{ type: "spring", duration: 0.55, bounce: 0.12 }}
          {...gazeProps("app_eigen", "Eigen dating app, open again", "app", { app: "Eigen" })}
        >
          <div className="chrome">
            <span className="lights">
              <i />
              <i />
              <i />
            </span>
            <span className="title">
              <span className="glyph">e</span> Eigen · 3 new people near you
            </span>
          </div>
          <div className="eigen-body">
            <ProfileCard c={c} index={0} total={1} compact />
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
