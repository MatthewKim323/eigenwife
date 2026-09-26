import { useId, useMemo, useState, type ReactNode } from "react";

/**
 * Procedural art, used when the generated webp portraits / food shots are
 * missing. Deterministic per seed. Every person is visibly synthetic:
 * character-select silhouettes with anime hair shapes on dreamy gradients.
 */

export type HairStyle =
  | "bob"
  | "braid"
  | "bun"
  | "wolf"
  | "wavy"
  | "curls"
  | "windswept"
  | "spacebuns"
  | "undercut"
  | "ponytail"
  | "straight"
  | "messy";
export type Accessory = "glasses" | "headphones" | "scarf" | "pearls" | "piercings" | "mic" | "camera" | "chalk" | "collar";
export type SceneKind =
  | "circuit"
  | "mountains"
  | "skyline"
  | "strobe"
  | "ceramics"
  | "marquee"
  | "coast"
  | "pixels"
  | "flash"
  | "sunrise"
  | "neonrain"
  | "stars";

export interface PersonArt {
  hue: number;
  hue2: number;
  hair: HairStyle;
  hairHue: number;
  hairL: number;
  hairC?: number;
  streakHue?: number;
  acc: Accessory[];
  scene: SceneKind;
  /** Skin tone as oklch L, C, H. */
  skin: [number, number, number];
}

export const PERSON_ART: Record<string, PersonArt> = {
  mira: { hue: 250, hue2: 205, hair: "bob", hairHue: 270, hairL: 0.22, acc: ["glasses"], scene: "circuit", skin: [0.8, 0.05, 60] },
  sol: { hue: 150, hue2: 60, hair: "braid", hairHue: 40, hairL: 0.34, acc: [], scene: "mountains", skin: [0.66, 0.08, 52] },
  vivienne: { hue: 60, hue2: 20, hair: "bun", hairHue: 30, hairL: 0.3, acc: ["pearls", "collar"], scene: "skyline", skin: [0.88, 0.045, 58] },
  kit: { hue: 330, hue2: 280, hair: "wolf", hairHue: 300, hairL: 0.3, streakHue: 350, acc: ["headphones"], scene: "strobe", skin: [0.86, 0.04, 50] },
  hana: { hue: 45, hue2: 15, hair: "wavy", hairHue: 40, hairL: 0.38, acc: [], scene: "ceramics", skin: [0.9, 0.035, 68] },
  zadie: { hue: 20, hue2: 350, hair: "curls", hairHue: 38, hairL: 0.55, hairC: 0.16, acc: ["mic"], scene: "marquee", skin: [0.9, 0.045, 42] },
  ines: { hue: 70, hue2: 200, hair: "windswept", hairHue: 70, hairL: 0.56, hairC: 0.09, acc: ["camera"], scene: "coast", skin: [0.76, 0.065, 58] },
  wren: { hue: 210, hue2: 280, hair: "spacebuns", hairHue: 250, hairL: 0.86, hairC: 0.02, acc: [], scene: "pixels", skin: [0.87, 0.04, 55] },
  dahlia: { hue: 10, hue2: 300, hair: "undercut", hairHue: 280, hairL: 0.16, acc: ["piercings"], scene: "flash", skin: [0.83, 0.04, 48] },
  priya: { hue: 185, hue2: 130, hair: "ponytail", hairHue: 30, hairL: 0.2, acc: ["chalk"], scene: "sunrise", skin: [0.58, 0.075, 48] },
  yuki: { hue: 285, hue2: 330, hair: "straight", hairHue: 280, hairL: 0.14, acc: ["collar"], scene: "neonrain", skin: [0.9, 0.035, 70] },
  ada: { hue: 265, hue2: 230, hair: "messy", hairHue: 30, hairL: 0.42, hairC: 0.12, acc: ["scarf"], scene: "stars", skin: [0.9, 0.045, 45] },
};

export function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ok = (l: number, c: number, h: number, a = 1) => `oklch(${l} ${c} ${h}${a < 1 ? ` / ${a}` : ""})`;

// ---------------------------------------------------------------------------
// Portrait (viewBox 0 0 300 450)
// ---------------------------------------------------------------------------

function hairBack(style: HairStyle, r: () => number): ReactNode {
  switch (style) {
    case "bob":
      return <path d="M88,176 C84,98 118,82 150,82 C184,82 216,98 212,176 L214,240 C196,250 176,244 166,238 L134,238 C124,244 104,250 86,240 Z" />;
    case "straight":
      return <path d="M86,172 C84,96 118,80 150,80 C182,80 216,96 214,172 L226,396 C200,404 180,392 170,380 L130,380 C120,392 100,404 74,396 Z" />;
    case "wavy":
      return (
        <path d="M90,170 C80,98 120,82 150,82 C184,82 222,98 212,170 C228,214 212,254 232,296 C244,330 222,362 230,398 C200,404 184,388 178,372 L122,372 C116,388 100,404 70,398 C78,362 56,330 68,296 C88,254 72,214 90,170 Z" />
      );
    case "curls": {
      const out: ReactNode[] = [];
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2;
        const rad = 74 + r() * 14;
        const cx = 150 + Math.cos(a) * rad * 0.95;
        const cy = 168 + Math.sin(a) * rad * 0.9 - 6;
        if (cy > 250) continue;
        out.push(<circle key={i} cx={cx} cy={cy} r={24 + r() * 12} />);
      }
      out.push(<ellipse key="core" cx={150} cy={160} rx={86} ry={84} />);
      return <g>{out}</g>;
    }
    case "bun":
      return (
        <g>
          <circle cx={150} cy={86} r={30} />
          <path d="M96,174 C94,106 122,90 150,90 C178,90 206,106 204,174 C200,150 190,136 150,132 C110,136 100,150 96,174 Z" />
        </g>
      );
    case "spacebuns":
      return (
        <g>
          <circle cx={104} cy={100} r={27} />
          <circle cx={196} cy={100} r={27} />
          <path d="M92,190 C88,106 120,88 150,88 C180,88 212,106 208,190 L214,226 L200,210 L100,210 L86,226 Z" />
        </g>
      );
    case "ponytail":
      return (
        <g>
          <path d="M196,112 C236,110 252,150 246,198 C242,236 258,270 276,292 C240,294 222,262 220,226 C218,190 214,150 190,130 Z" />
          <path d="M94,176 C90,104 120,88 150,88 C182,88 210,104 206,176 Z" />
        </g>
      );
    case "braid":
      return <path d="M92,178 C88,102 120,86 150,86 C182,86 212,102 208,178 Z" />;
    case "wolf":
      return (
        <path d="M86,178 L76,150 L90,128 L82,104 L106,96 L108,74 L132,86 L150,68 L168,86 L192,74 L196,96 L220,104 L210,128 L226,150 L214,180 L230,226 L204,208 L210,250 L186,226 L172,256 L160,232 L140,232 L128,256 L114,226 L90,250 L96,208 L70,226 Z" />
      );
    case "undercut":
      return <path d="M98,176 C96,104 124,88 152,88 C184,88 208,106 204,176 C200,150 196,136 186,128 Z" />;
    case "windswept":
      return (
        <path d="M90,172 C84,98 122,82 154,84 C200,88 218,118 214,156 C236,184 262,208 292,222 C262,232 240,226 226,220 C234,256 250,284 272,306 C236,310 216,288 206,262 L206,300 C190,290 186,270 186,250 L118,250 C110,280 96,300 76,310 C84,284 88,250 82,222 C74,204 84,186 90,172 Z" />
      );
    case "messy":
      return (
        <path d="M84,186 C70,160 86,140 82,118 C92,96 110,94 116,82 C132,86 138,72 152,74 C166,70 176,84 190,82 C206,92 212,104 220,116 C216,138 232,158 218,186 C222,212 212,232 204,246 L96,246 C86,230 78,210 84,186 Z" />
      );
  }
}

function hairFront(style: HairStyle): ReactNode {
  switch (style) {
    case "bob":
    case "straight":
      return <path d="M100,170 C96,110 126,90 150,90 C176,90 206,110 200,170 L198,150 C196,146 196,140 196,138 L104,138 C104,142 102,146 102,150 Z" />;
    case "wavy":
    case "messy":
      return <path d="M100,176 C94,110 126,90 152,90 C182,90 208,112 200,168 C188,140 170,124 144,128 C126,132 112,146 100,176 Z" />;
    case "curls":
      return <path d="M102,160 C104,112 130,98 150,98 C174,98 198,112 198,160 C186,140 172,130 150,130 C128,130 114,140 102,160 Z" />;
    case "bun":
    case "ponytail":
    case "braid":
      return <path d="M100,172 C98,112 126,94 150,94 C176,94 202,112 200,172 C194,142 178,126 150,124 C130,124 110,136 100,172 Z" />;
    case "spacebuns":
      return <path d="M100,166 C98,112 126,94 150,94 C176,94 202,112 200,166 L186,142 L172,152 L160,138 L146,152 L134,138 L120,152 L110,142 Z" />;
    case "wolf":
      return <path d="M98,176 C92,112 124,90 150,90 C178,90 208,112 202,176 L190,146 L182,164 L172,136 L160,160 L150,134 L138,160 L126,138 L118,164 L108,146 Z" />;
    case "undercut":
      return <path d="M200,150 C206,104 172,88 142,90 C112,92 92,118 96,204 C104,170 112,152 132,142 C160,130 186,132 200,150 Z" />;
    case "windswept":
      return <path d="M100,170 C96,112 126,92 154,92 C184,92 206,110 202,146 C190,130 168,122 140,128 C120,134 106,150 100,170 Z" />;
  }
}

function Braid({ fill }: { fill: string }) {
  const segs = [];
  for (let i = 0; i < 9; i++) {
    const t = i / 8;
    const x = 188 + t * 26 + Math.sin(i) * 3;
    const y = 212 + t * 170;
    segs.push(<ellipse key={i} cx={x} cy={y} rx={15 - t * 4} ry={13} transform={`rotate(${i % 2 ? 24 : -24} ${x} ${y})`} fill={fill} />);
  }
  return <g>{segs}</g>;
}

export function PortraitArt({ id, name, className }: { id: string; name: string; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const art = PERSON_ART[id] ?? PERSON_ART.mira!;
  const r = useMemo(() => rng(id), [id]);
  const bokeh = useMemo(() => {
    const rr = rng(`${id}-bokeh`);
    return Array.from({ length: 16 }, (_, i) => ({ i, x: rr() * 300, y: rr() * 300, r: 4 + rr() * 26, a: 0.08 + rr() * 0.22 }));
  }, [id]);
  const back = useMemo(() => hairBack(art.hair, r), [art.hair, r]);
  const hairC = art.hairC ?? 0.08;
  const hair = ok(art.hairL, hairC, art.hairHue);
  const hairHi = ok(Math.min(0.95, art.hairL + 0.22), hairC + 0.04, art.hairHue);
  const [sl, sc, sh] = art.skin;
  const skinTop = ok(Math.min(0.96, sl + 0.05), sc, sh + 5);
  const skinBot = ok(sl - 0.08, sc + 0.015, sh - 5);
  return (
    <svg className={className} viewBox="30 18 240 420" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`illustrated portrait of ${name}`}>
      <defs>
        <linearGradient id={`bg${uid}`} x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0" style={{ stopColor: ok(0.74, 0.13, art.hue) }} />
          <stop offset="0.55" style={{ stopColor: ok(0.5, 0.15, art.hue2) }} />
          <stop offset="1" style={{ stopColor: ok(0.18, 0.08, art.hue2 + 20) }} />
        </linearGradient>
        <radialGradient id={`glow${uid}`} cx="0.5" cy="0.38" r="0.5">
          <stop offset="0" style={{ stopColor: ok(0.95, 0.08, art.hue + 40, 0.85) }} />
          <stop offset="1" style={{ stopColor: ok(0.9, 0.08, art.hue + 40, 0) }} />
        </radialGradient>
        <linearGradient id={`skin${uid}`} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" style={{ stopColor: skinTop }} />
          <stop offset="1" style={{ stopColor: skinBot }} />
        </linearGradient>
        <linearGradient id={`body${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: ok(0.3, 0.06, art.hue2) }} />
          <stop offset="1" style={{ stopColor: ok(0.16, 0.05, art.hue2 + 30) }} />
        </linearGradient>
        <linearGradient id={`hair${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: hairHi }} />
          <stop offset="0.5" style={{ stopColor: hair }} />
          <stop offset="1" style={{ stopColor: ok(Math.max(0.08, art.hairL - 0.1), hairC, art.hairHue) }} />
        </linearGradient>
        <pattern id={`dots${uid}`} width="7" height="7" patternUnits="userSpaceOnUse">
          <circle cx="3.5" cy="3.5" r="1.1" fill="white" opacity="0.18" />
        </pattern>
        <linearGradient id={`fade${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.55" stopColor="black" stopOpacity="0" />
          <stop offset="1" stopColor="black" stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect width="300" height="450" fill={`url(#bg${uid})`} />
      <text x="-14" y="330" fontSize="360" fontFamily="DM Sans" fontWeight="700" fill="none" stroke="white" strokeOpacity="0.1" strokeWidth="2">
        {name[0]}
      </text>
      {bokeh.map((b) => (
        <circle key={b.i} cx={b.x} cy={b.y} r={b.r} fill="white" opacity={b.a} />
      ))}
      <rect width="300" height="450" fill={`url(#dots${uid})`} style={{ maskImage: "none" }} opacity="0.6" />
      <circle cx="150" cy="170" r="150" fill={`url(#glow${uid})`} />

      {/* hair behind */}
      <g fill={`url(#hair${uid})`}>{back}</g>

      {/* shoulders + neck */}
      <path d="M22,470 C26,330 84,290 130,280 L170,280 C216,290 274,330 278,470 Z" fill={`url(#body${uid})`} />
      <path d="M22,470 C26,330 84,290 130,280 L170,280 C216,290 274,330 278,470" fill="none" stroke={ok(0.9, 0.1, art.hue, 0.5)} strokeWidth="1.5" />
      <path d="M134,222 L134,282 C140,292 160,292 166,282 L166,222 Z" fill={`url(#skin${uid})`} />
      <path d="M134,262 C144,272 156,272 166,262 L166,250 C156,258 144,258 134,250 Z" fill={ok(0.6, 0.06, art.hue)} opacity="0.35" />

      {art.acc.includes("collar") && <path d="M112,288 L150,318 L188,288 L176,284 L150,304 L124,284 Z" fill={ok(0.95, 0.02, art.hue)} opacity="0.9" />}
      {art.acc.includes("chalk") && (
        <g opacity="0.8">
          <circle cx="78" cy="400" r="16" fill="white" opacity="0.25" />
          <circle cx="92" cy="386" r="9" fill="white" opacity="0.2" />
        </g>
      )}

      {/* head */}
      <ellipse cx="150" cy="172" rx="49" ry="61" fill={`url(#skin${uid})`} />
      <path d="M188,130 C204,152 204,196 186,222" fill="none" stroke={ok(0.97, 0.06, art.hue)} strokeOpacity="0.55" strokeWidth="2.5" strokeLinecap="round" />
      <ellipse cx="102" cy="180" rx="7" ry="12" fill={`url(#skin${uid})`} />
      <ellipse cx="198" cy="180" rx="7" ry="12" fill={`url(#skin${uid})`} />
      {/* face: soft closed-eye smile, blush */}
      <g fill="none" stroke={ok(0.28, 0.05, art.hairHue)} strokeWidth="2.6" strokeLinecap="round">
        <path d="M120,184 Q129,176 138,184" />
        <path d="M162,184 Q171,176 180,184" />
        <path d="M143,212 Q150,217 157,212" strokeWidth="2" />
      </g>
      <ellipse cx="122" cy="198" rx="10" ry="5" fill={ok(0.75, 0.12, 15, 0.45)} />
      <ellipse cx="178" cy="198" rx="10" ry="5" fill={ok(0.75, 0.12, 15, 0.45)} />

      {art.acc.includes("glasses") && (
        <g fill="none" stroke={ok(0.2, 0.02, 260)} strokeWidth="2.4">
          <circle cx="129" cy="182" r="14" />
          <circle cx="171" cy="182" r="14" />
          <path d="M143,181 Q150,176 157,181" />
          <circle cx="129" cy="182" r="14" fill="white" fillOpacity="0.12" stroke="none" />
        </g>
      )}

      {/* hair front */}
      <g fill={`url(#hair${uid})`}>{hairFront(art.hair)}</g>
      {art.hair === "braid" && <Braid fill={`url(#hair${uid})`} />}
      {art.streakHue !== undefined && (
        <path d="M160,94 L172,136 L182,164 L190,146 L186,110 Z" fill={ok(0.72, 0.18, art.streakHue)} opacity="0.9" />
      )}
      <path d="M118,110 C132,98 150,96 164,100" fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round" />

      {art.acc.includes("pearls") && (
        <g fill="white">
          <circle cx="101" cy="198" r="4" />
          <circle cx="199" cy="198" r="4" />
        </g>
      )}
      {art.acc.includes("piercings") && (
        <g fill="none" stroke={ok(0.9, 0.02, 90)} strokeWidth="1.8">
          <circle cx="150" cy="205" r="3.5" />
          <circle cx="99" cy="190" r="3" />
          <circle cx="100" cy="176" r="2.5" />
        </g>
      )}
      {art.acc.includes("headphones") && (
        <g>
          <path d="M100,262 C100,300 200,300 200,262" fill="none" stroke={ok(0.25, 0.04, 280)} strokeWidth="8" />
          <rect x="84" y="244" width="30" height="40" rx="12" fill={ok(0.3, 0.05, 280)} />
          <rect x="186" y="244" width="30" height="40" rx="12" fill={ok(0.3, 0.05, 280)} />
          <rect x="190" y="252" width="6" height="24" rx="3" fill={ok(0.8, 0.18, 350)} />
        </g>
      )}
      {art.acc.includes("scarf") && (
        <g>
          <path d="M92,244 C104,222 196,222 208,244 C218,268 204,290 150,294 C96,290 82,268 92,244 Z" fill={ok(0.62, 0.13, 25)} />
          <path d="M170,280 L190,360 L162,364 L150,288 Z" fill={ok(0.56, 0.13, 25)} />
          <g stroke={ok(0.5, 0.12, 25)} strokeWidth="3" opacity="0.7">
            <path d="M108,250 L112,280" />
            <path d="M130,244 L132,288" />
            <path d="M152,242 L152,292" />
            <path d="M174,244 L172,288" />
            <path d="M194,250 L190,280" />
          </g>
        </g>
      )}
      {art.acc.includes("mic") && (
        <g transform="rotate(-18 236 350)">
          <rect x="228" y="330" width="16" height="90" rx="6" fill={ok(0.2, 0.01, 0)} />
          <ellipse cx="236" cy="324" rx="18" ry="22" fill={ok(0.55, 0.01, 0)} />
          <ellipse cx="236" cy="324" rx="18" ry="22" fill={`url(#dots${uid})`} />
        </g>
      )}
      {art.acc.includes("camera") && (
        <g transform="rotate(-8 84 380)">
          <rect x="48" y="360" width="76" height="48" rx="8" fill={ok(0.22, 0.02, 60)} />
          <rect x="54" y="352" width="22" height="10" rx="3" fill={ok(0.3, 0.02, 60)} />
          <circle cx="92" cy="384" r="17" fill={ok(0.12, 0.02, 250)} stroke={ok(0.7, 0.02, 60)} strokeWidth="3" />
          <circle cx="97" cy="379" r="5" fill="white" opacity="0.5" />
        </g>
      )}
      {art.hair === "undercut" && (
        <g stroke={ok(0.2, 0.04, 280)} strokeWidth="2" fill="none" opacity="0.55">
          <path d="M60,420 C70,380 90,360 100,330" />
          <path d="M80,380 C92,372 98,360 96,346" />
          <path d="M240,420 C232,380 214,360 202,330" />
          <circle cx="218" cy="372" r="10" />
        </g>
      )}
      <rect width="300" height="450" fill={`url(#fade${uid})`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Scene photo (viewBox 0 0 300 200)
// ---------------------------------------------------------------------------

export function SceneArt({ id, className }: { id: string; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const art = PERSON_ART[id] ?? PERSON_ART.mira!;
  const r = useMemo(() => rng(`${id}-scene`), [id]);
  const content = useMemo(() => paintScene(art, r, uid), [art, r, uid]);
  return (
    <svg className={className} viewBox="0 0 300 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="illustrated scene">
      <defs>
        <linearGradient id={`sky${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: ok(0.3, 0.1, art.hue2) }} />
          <stop offset="1" style={{ stopColor: ok(0.62, 0.12, art.hue) }} />
        </linearGradient>
        <radialGradient id={`sun${uid}`}>
          <stop offset="0" style={{ stopColor: ok(0.97, 0.08, art.hue + 40) }} />
          <stop offset="1" style={{ stopColor: ok(0.9, 0.12, art.hue + 40, 0) }} />
        </radialGradient>
      </defs>
      <rect width="300" height="200" fill={`url(#sky${uid})`} />
      {content}
    </svg>
  );
}

function paintScene(art: PersonArt, r: () => number, uid: string): ReactNode {
  const h = art.hue;
  const h2 = art.hue2;
  switch (art.scene) {
    case "circuit":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.2, 0.05, 160)} />
          {Array.from({ length: 22 }, (_, i) => {
            const x = r() * 300;
            const y = r() * 200;
            return <path key={i} d={`M${x},${y} h${20 + r() * 50} v${(r() - 0.5) * 60} h${20 + r() * 40}`} stroke={ok(0.75, 0.14, 150, 0.6)} strokeWidth="1.5" fill="none" />;
          })}
          {Array.from({ length: 30 }, (_, i) => (
            <circle key={i} cx={r() * 300} cy={r() * 200} r={2 + r() * 2} fill={ok(0.85, 0.12, 90)} />
          ))}
          <ellipse cx="220" cy="150" rx="46" ry="26" fill={ok(0.12, 0.01, 0)} />
          <circle cx="252" cy="130" r="18" fill={ok(0.12, 0.01, 0)} />
          <path d="M240,116 l6,-14 l6,12 M256,114 l6,-14 l4,14" fill={ok(0.12, 0.01, 0)} />
          <circle cx="60" cy="40" r="80" fill={`url(#sun${uid})`} opacity="0.5" />
        </g>
      );
    case "mountains":
      return (
        <g>
          <circle cx="210" cy="80" r="70" fill={`url(#sun${uid})`} />
          <path d="M0,140 L60,60 L100,110 L150,40 L210,120 L250,70 L300,130 L300,200 L0,200 Z" fill={ok(0.45, 0.08, 280)} />
          <path d="M150,40 L166,62 L156,58 L146,70 L138,56 Z M60,60 L72,76 L62,72 L52,80 Z" fill="white" opacity="0.8" />
          <rect y="140" width="300" height="60" fill={ok(0.55, 0.1, 220)} />
          <path d="M0,150 H300 M20,162 H280 M50,176 H250" stroke="white" strokeOpacity="0.35" />
          <path d="M40,150 L62,128 L84,150 Z" fill={ok(0.66, 0.17, 45)} />
        </g>
      );
    case "skyline":
      return (
        <g>
          <circle cx="80" cy="130" r="60" fill={`url(#sun${uid})`} />
          {Array.from({ length: 16 }, (_, i) => {
            const w = 14 + r() * 16;
            const x = i * 19;
            const hh = 40 + r() * 110;
            return (
              <g key={i}>
                <rect x={x} y={200 - hh} width={w} height={hh} fill={ok(0.2 + r() * 0.08, 0.04, 260)} />
                {Array.from({ length: Math.floor(hh / 12) }, (_, j) => (r() > 0.55 ? <rect key={j} x={x + 3} y={200 - hh + 6 + j * 12} width={w - 6} height="3" fill={ok(0.9, 0.12, 80, 0.7)} /> : null))}
              </g>
            );
          })}
          <rect x="0" y="0" width="300" height="200" fill="none" stroke={ok(0.95, 0.02, 0, 0.3)} strokeWidth="18" />
        </g>
      );
    case "strobe":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.12, 0.05, 300)} />
          {Array.from({ length: 7 }, (_, i) => (
            <path key={i} d={`M150,-10 L${-40 + i * 64},210 L${-10 + i * 64},210 Z`} fill={ok(0.75, 0.2, i % 2 ? 340 : 200, 0.28)} />
          ))}
          {Array.from({ length: 40 }, (_, i) => (
            <circle key={i} cx={r() * 300} cy={130 + r() * 70} r={6 + r() * 8} fill={ok(0.1, 0.02, 280)} />
          ))}
          <rect x="90" y="150" width="120" height="50" rx="4" fill={ok(0.16, 0.03, 280)} />
          <circle cx="120" cy="170" r="12" fill="none" stroke={ok(0.8, 0.18, 340)} strokeWidth="3" />
          <circle cx="180" cy="170" r="12" fill="none" stroke={ok(0.8, 0.14, 200)} strokeWidth="3" />
          {Array.from({ length: 30 }, (_, i) => (
            <rect key={`c${i}`} x={r() * 300} y={r() * 140} width="4" height="7" fill={ok(0.85, 0.16, r() * 360)} transform={`rotate(${r() * 90})`} />
          ))}
        </g>
      );
    case "ceramics":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.84, 0.04, 60)} />
          <rect x="0" y="0" width="120" height="200" fill={ok(0.92, 0.04, 80)} />
          <rect x="0" y="120" width="300" height="8" fill={ok(0.55, 0.06, 55)} />
          <rect x="0" y="190" width="300" height="10" fill={ok(0.55, 0.06, 55)} />
          {[
            [40, 88, 26, 32, 200],
            [100, 92, 22, 28, 20],
            [160, 84, 30, 36, 150],
            [226, 90, 24, 30, 330],
            [70, 160, 30, 30, 60],
            [150, 166, 38, 24, 250],
            [236, 158, 26, 32, 10],
          ].map(([x, y, w, hh, hu], i) => (
            <g key={i} transform={i === 3 ? `rotate(-7 ${x} ${y})` : undefined}>
              <rect x={x! - w! / 2} y={y! - hh! / 2 + 4} width={w} height={hh} rx="9" fill={ok(0.72, 0.08, hu!)} />
              <ellipse cx={x} cy={y! - hh! / 2 + 4} rx={w! / 2} ry="4" fill={ok(0.52, 0.08, hu!)} />
            </g>
          ))}
          <path d="M270,30 q10,20 -4,40 q20,-10 16,30" stroke={ok(0.55, 0.12, 145)} strokeWidth="5" fill="none" />
        </g>
      );
    case "marquee":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.16, 0.05, 20)} />
          <rect x="30" y="28" width="240" height="84" rx="6" fill={ok(0.24, 0.07, 20)} stroke={ok(0.8, 0.14, 70)} strokeWidth="2" />
          {Array.from({ length: 30 }, (_, i) => {
            const t = i / 30;
            const x = t < 0.5 ? 30 + t * 2 * 240 : 270 - (t - 0.5) * 2 * 240;
            const y = t < 0.5 ? 28 : 112;
            return <circle key={i} cx={x} cy={y} r="4" fill={ok(0.92, 0.14, 80)} />;
          })}
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <rect key={i} x={52 + i * 30} y="54" width="22" height="30" rx="2" fill={ok(0.95, 0.02, 80)} opacity="0.9" />
          ))}
          <rect y="150" width="300" height="50" fill={ok(0.2, 0.05, 20)} />
          <path d="M0,160 H300" stroke={ok(0.8, 0.14, 40, 0.4)} strokeWidth="1" />
          {Array.from({ length: 9 }, (_, i) => (
            <path key={i} d={`M${20 + i * 32},156 a14,10 0 0,1 28,0 Z`} fill={ok(0.4 + r() * 0.2, 0.12, r() * 360)} />
          ))}
          {Array.from({ length: 40 }, (_, i) => (
            <path key={`r${i}`} d={`M${r() * 300},${r() * 200} l-3,10`} stroke="white" strokeOpacity="0.25" />
          ))}
        </g>
      );
    case "coast":
      return (
        <g>
          <circle cx="150" cy="118" r="80" fill={`url(#sun${uid})`} />
          <circle cx="150" cy="118" r="26" fill={ok(0.96, 0.08, 80)} />
          <rect y="120" width="300" height="80" fill={ok(0.5, 0.1, 225)} />
          {Array.from({ length: 10 }, (_, i) => (
            <path key={i} d={`M${120 - i * 6},${126 + i * 7} H${180 + i * 6}`} stroke={ok(0.95, 0.1, 80, 0.7 - i * 0.06)} strokeWidth="2" />
          ))}
          <path d="M0,170 C60,150 90,160 120,200 L0,200 Z" fill={ok(0.72, 0.06, 60)} />
          <path d="M210,40 q10,-8 20,0 q10,-8 20,0" stroke={ok(0.3, 0.02, 250)} fill="none" strokeWidth="2" />
          <rect x="226" y="140" width="40" height="18" rx="9" fill={ok(0.8, 0.09, 170)} />
          <circle cx="232" cy="160" r="7" fill={ok(0.2, 0.01, 0)} />
          <circle cx="262" cy="160" r="7" fill={ok(0.2, 0.01, 0)} />
        </g>
      );
    case "pixels":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.16, 0.05, 260)} />
          {Array.from({ length: 150 }, (_, i) => {
            const x = (i % 15) * 20;
            const y = Math.floor(i / 15) * 20;
            return r() > 0.62 ? <rect key={i} x={x + 1} y={y + 1} width="18" height="18" fill={ok(0.5 + r() * 0.3, 0.14, 180 + r() * 120, 0.5 + r() * 0.4)} /> : null;
          })}
          <rect x="112" y="72" width="76" height="56" rx="10" fill={ok(0.9, 0.04, 260)} />
          <rect x="126" y="86" width="14" height="14" fill={ok(0.2, 0.05, 260)} />
          <rect x="160" y="86" width="14" height="14" fill={ok(0.2, 0.05, 260)} />
          <rect x="136" y="110" width="28" height="6" fill={ok(0.2, 0.05, 260)} />
        </g>
      );
    case "flash":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.9, 0.03, 80)} />
          {[
            [50, 50],
            [150, 60],
            [250, 50],
            [60, 150],
            [240, 150],
          ].map(([x, y], i) => (
            <g key={i} transform={`translate(${x} ${y}) rotate(${(r() - 0.5) * 30})`} fill="none" stroke={ok(0.2, 0.02, 0)} strokeWidth="2">
              {i % 2 ? (
                <path d="M0,-22 C12,-10 12,10 0,22 C-12,10 -12,-10 0,-22 Z M0,-22 v44" />
              ) : (
                <path d="M-6,-24 L6,-24 L4,10 L0,24 L-4,10 Z M-16,-14 H16" />
              )}
            </g>
          ))}
          <g transform="translate(150 140)" stroke={ok(0.2, 0.02, 0)} strokeWidth="2.2">
            <path d="M0,-20 C-40,-50 -60,-10 -30,10 C-50,30 -20,40 0,14 C20,40 50,30 30,10 C60,-10 40,-50 0,-20 Z" fill={ok(0.62, 0.2, 15)} />
            <path d="M0,-24 V30" />
            <path d="M-4,-26 q-8,-14 -16,-12 M4,-26 q8,-14 18,-8" fill="none" />
          </g>
          <rect width="300" height="200" fill={ok(0.5, 0.2, 15, 0.12)} />
        </g>
      );
    case "sunrise":
      return (
        <g>
          <circle cx="150" cy="150" r="110" fill={`url(#sun${uid})`} />
          <circle cx="150" cy="150" r="30" fill={ok(0.95, 0.1, 70)} />
          {Array.from({ length: 12 }, (_, i) => {
            const w = 16 + r() * 20;
            const hh = 20 + r() * 50;
            return <rect key={i} x={i * 26} y={200 - hh} width={w} height={hh} fill={ok(0.3, 0.05, 250)} />;
          })}
          <rect y="150" width="300" height="50" fill={ok(0.24, 0.04, 250)} />
          <path d="M0,152 H300" stroke={ok(0.8, 0.02, 0, 0.5)} strokeWidth="2" />
          <g transform="translate(200 120)">
            <path d="M0,0 L30,0 L26,40 L4,40 Z" fill={ok(0.95, 0.01, 0)} />
            <rect x="-2" y="-6" width="34" height="8" rx="2" fill={ok(0.35, 0.06, 180)} />
            <path d="M32,12 q10,0 10,10 q0,8 -12,8" fill="none" stroke={ok(0.95, 0.01, 0)} strokeWidth="3" />
          </g>
        </g>
      );
    case "neonrain":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.14, 0.05, 280)} />
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={i * 40 + r() * 10} y={20 + r() * 40} width={10 + r() * 14} height={60 + r() * 60} rx="2" fill={ok(0.72, 0.18, [330, 200, 60, 290][i % 4]!, 0.7)} />
          ))}
          <rect x="120" y="40" width="70" height="120" fill={ok(0.9, 0.02, 0)} opacity="0.9" />
          <path d="M155,40 C140,70 130,110 150,160 M155,40 C170,70 180,110 160,160" stroke={ok(0.3, 0.1, 290)} strokeWidth="2" fill="none" />
          {Array.from({ length: 80 }, (_, i) => (
            <path key={`r${i}`} d={`M${r() * 300},${r() * 200} l-2,12`} stroke="white" strokeOpacity={0.15 + r() * 0.25} />
          ))}
          <rect y="170" width="300" height="30" fill={ok(0.2, 0.05, 280, 0.8)} />
        </g>
      );
    case "stars":
      return (
        <g>
          <rect width="300" height="200" fill={ok(0.14, 0.06, h)} />
          <path d="M0,120 C80,60 200,40 300,10 L300,60 C200,80 90,110 0,160 Z" fill={ok(0.5, 0.08, h2, 0.35)} />
          {Array.from({ length: 90 }, (_, i) => (
            <circle key={i} cx={r() * 300} cy={r() * 160} r={r() * 1.4 + 0.3} fill="white" opacity={0.4 + r() * 0.6} />
          ))}
          <path d="M60,200 L60,150 A90,70 0 0 1 240,150 L240,200 Z" fill={ok(0.28, 0.02, 260)} />
          <path d="M140,82 L160,82 L168,150 L132,150 Z" fill={ok(0.1, 0.03, 260)} />
          <path d="M150,110 L200,60" stroke={ok(0.75, 0.02, 260)} strokeWidth="8" strokeLinecap="round" />
          <circle cx="90" cy="176" r="3" fill={ok(0.65, 0.2, 25)} />
        </g>
      );
  }
}

// ---------------------------------------------------------------------------
// Food (viewBox 0 0 300 220)
// ---------------------------------------------------------------------------

export function FoodArt({ id, className }: { id: string; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const r = useMemo(() => rng(`food-${id}`), [id]);
  const spec = FOOD[id] ?? FOOD["garlic-knockout"]!;
  const noodles = useMemo(
    () =>
      Array.from({ length: 9 }, (_, i) => {
        const y = 118 + i * 5 + r() * 4;
        const x0 = 64 + r() * 20;
        let d = `M${x0},${y}`;
        for (let x = x0; x < 236; x += 16) d += ` q8,${(r() - 0.5) * 14} 16,0`;
        return d;
      }),
    [r],
  );
  const dots = useMemo(() => Array.from({ length: 22 }, () => ({ x: 70 + r() * 160, y: 108 + r() * 50, s: r() })), [r]);
  return (
    <svg className={className} viewBox="0 0 300 220" preserveAspectRatio="xMidYMid slice" role="img" aria-label="illustrated dish">
      <defs>
        <radialGradient id={`tbl${uid}`} cx="0.5" cy="0.3" r="0.8">
          <stop offset="0" style={{ stopColor: ok(0.34, 0.05, 50) }} />
          <stop offset="1" style={{ stopColor: ok(0.14, 0.03, 40) }} />
        </radialGradient>
        <radialGradient id={`broth${uid}`} cx="0.45" cy="0.35" r="0.7">
          <stop offset="0" style={{ stopColor: ok(spec.brothL + 0.12, spec.brothC, spec.brothH) }} />
          <stop offset="1" style={{ stopColor: ok(spec.brothL - 0.08, spec.brothC, spec.brothH - 10) }} />
        </radialGradient>
        <linearGradient id={`bowl${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: ok(spec.bowlL + 0.1, 0.02, 40) }} />
          <stop offset="1" style={{ stopColor: ok(spec.bowlL - 0.1, 0.02, 40) }} />
        </linearGradient>
        <clipPath id={`clip${uid}`}>
          <ellipse cx="150" cy="130" rx="98" ry="46" />
        </clipPath>
      </defs>
      <rect width="300" height="220" fill={`url(#tbl${uid})`} />
      {Array.from({ length: 6 }, (_, i) => (
        <path key={i} d={`M0,${40 + i * 34} C80,${30 + i * 34} 200,${50 + i * 34} 300,${38 + i * 34}`} stroke={ok(0.4, 0.05, 50, 0.25)} fill="none" />
      ))}
      <ellipse cx="150" cy="178" rx="120" ry="26" fill="black" opacity="0.35" />
      {spec.plate ? (
        <g>
          <ellipse cx="150" cy="140" rx="118" ry="52" fill={ok(0.9, 0.02, 60)} />
          <ellipse cx="150" cy="136" rx="96" ry="40" fill={ok(0.84, 0.02, 60)} />
          {Array.from({ length: 5 }, (_, i) => {
            const x = 104 + i * 22 + r() * 8;
            const y = 124 + (i % 2) * 14;
            return (
              <g key={i}>
                <ellipse cx={x} cy={y} rx="20" ry="15" fill={ok(0.5, 0.11, 55)} />
                <ellipse cx={x - 4} cy={y - 5} rx="10" ry="5" fill={ok(0.72, 0.12, 70)} opacity="0.7" />
                <path d={`M${x - 12},${y} q6,-6 12,0 q6,6 12,0`} stroke={ok(0.2, 0.04, 40)} strokeWidth="3" fill="none" opacity="0.8" />
              </g>
            );
          })}
          <path d="M96,150 q30,10 60,0 q30,-10 50,4" stroke={ok(0.95, 0.03, 90)} strokeWidth="4" fill="none" />
          <path d="M210,112 a16,12 0 1,1 20,14 Z" fill={ok(0.9, 0.16, 100)} />
        </g>
      ) : (
        <g>
          <path d="M40,130 C44,196 256,196 260,130 Z" fill={`url(#bowl${uid})`} />
          <ellipse cx="150" cy="130" rx="110" ry="52" fill={ok(spec.bowlL + 0.16, 0.02, 40)} />
          <ellipse cx="150" cy="130" rx="100" ry="47" fill={ok(spec.bowlL - 0.04, 0.02, 40)} />
          <ellipse cx="150" cy="130" rx="98" ry="46" fill={`url(#broth${uid})`} />
          <g clipPath={`url(#clip${uid})`}>
            {noodles.map((d, i) => (
              <path key={i} d={d} stroke={ok(0.88, 0.09, 90)} strokeWidth="4" fill="none" strokeLinecap="round" opacity="0.9" />
            ))}
            {spec.oil &&
              dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={1.5 + d.s * 4} fill={ok(spec.oil![0], spec.oil![1], spec.oil![2], 0.75)} />)}
            {spec.toppings.includes("nori") && <rect x="200" y="70" width="34" height="56" rx="2" fill={ok(0.18, 0.04, 150)} transform="rotate(12 217 98)" />}
            {spec.toppings.includes("chashu") &&
              [
                [104, 116],
                [128, 106],
              ].map(([x, y], i) => (
                <g key={i}>
                  <ellipse cx={x} cy={y} rx="26" ry="16" fill={ok(0.72, 0.08, 30)} />
                  <ellipse cx={x} cy={y} rx="26" ry="16" fill="none" stroke={ok(0.45, 0.08, 40)} strokeWidth="4" />
                  <path d={`M${x! - 12},${y} q12,-8 24,0`} stroke={ok(0.9, 0.04, 40)} strokeWidth="2" fill="none" />
                </g>
              ))}
            {spec.toppings.includes("wagyu") &&
              [0, 1, 2].map((i) => (
                <g key={i} transform={`rotate(${-12 + i * 10} ${110 + i * 26} ${112})`}>
                  <rect x={92 + i * 26} y={98} width="30" height="30" rx="4" fill={ok(0.58, 0.14, 20)} />
                  <path d={`M${96 + i * 26},${106} l20,4 M${98 + i * 26},${116} l16,-2 M${96 + i * 26},${122} l22,2`} stroke="white" strokeOpacity="0.55" strokeWidth="1.5" />
                </g>
              ))}
            {spec.toppings.includes("egg") &&
              [
                [182, 138],
                [202, 130],
              ].map(([x, y], i) => (
                <g key={i}>
                  <ellipse cx={x} cy={y} rx="17" ry="12" fill={ok(0.95, 0.02, 80)} />
                  <ellipse cx={x} cy={y! + 1} rx="9" ry="7" fill={ok(0.72, 0.17, 60)} />
                </g>
              ))}
            {spec.toppings.includes("pork") && dots.slice(0, 14).map((d, i) => <circle key={i} cx={130 + (d.x - 150) * 0.4} cy={d.y - 4} r={4 + d.s * 3} fill={ok(0.42, 0.1, 35)} />)}
            {spec.toppings.includes("bokchoy") && <path d="M170,110 q20,-16 40,4 q-20,14 -40,-4 Z" fill={ok(0.62, 0.15, 140)} />}
            {spec.toppings.includes("tofu") &&
              [0, 1, 2, 3].map((i) => <rect key={i} x={110 + i * 18} y={106 + (i % 2) * 12} width="14" height="14" rx="2" fill={ok(0.88, 0.08, 85)} />)}
            {spec.toppings.includes("corn") && dots.slice(0, 16).map((d, i) => <circle key={i} cx={176 + (d.x - 150) * 0.25} cy={d.y} r="3.4" fill={ok(0.86, 0.16, 90)} />)}
            {spec.toppings.includes("yuzu") &&
              [0, 1, 2].map((i) => <path key={i} d={`M${140 + i * 16},${122 + (i % 2) * 8} q8,-6 14,0`} stroke={ok(0.88, 0.17, 100)} strokeWidth="3" fill="none" />)}
            {spec.toppings.includes("scallion") &&
              dots.map((d, i) => <circle key={`s${i}`} cx={d.x + 8} cy={d.y - 6} r="2.6" fill={ok(0.72, 0.17, 140)} opacity={d.s > 0.4 ? 1 : 0} />)}
          </g>
          <ellipse cx="150" cy="130" rx="110" ry="52" fill="none" stroke="white" strokeOpacity="0.18" strokeWidth="2" />
        </g>
      )}
      <g className="steam" stroke="white" strokeOpacity="0.28" strokeWidth="4" fill="none" strokeLinecap="round">
        <path d="M120,70 c-10,-14 10,-22 0,-38" />
        <path d="M152,62 c-10,-14 10,-22 0,-40" />
        <path d="M184,70 c-10,-14 10,-22 0,-38" />
      </g>
    </svg>
  );
}

const FOOD: Record<string, { brothH: number; brothC: number; brothL: number; bowlL: number; oil?: [number, number, number]; toppings: string[]; plate?: boolean }> = {
  "garlic-knockout": { brothH: 75, brothC: 0.06, brothL: 0.8, bowlL: 0.22, oil: [0.18, 0.03, 60], toppings: ["nori", "chashu", "egg", "scallion"] },
  "a5-wagyu": { brothH: 70, brothC: 0.14, brothL: 0.66, bowlL: 0.14, oil: [0.8, 0.14, 95], toppings: ["wagyu", "scallion"] },
  tantanmen: { brothH: 32, brothC: 0.17, brothL: 0.56, bowlL: 0.88, oil: [0.5, 0.2, 28], toppings: ["pork", "bokchoy", "scallion"] },
  "yuzu-shio": { brothH: 90, brothC: 0.09, brothL: 0.82, bowlL: 0.9, oil: [0.92, 0.1, 95], toppings: ["chashu", "yuzu", "scallion"] },
  "miso-veggie": { brothH: 55, brothC: 0.15, brothL: 0.66, bowlL: 0.3, oil: [0.55, 0.19, 35], toppings: ["tofu", "corn", "scallion"] },
  karaage: { brothH: 0, brothC: 0, brothL: 0, bowlL: 0, toppings: [], plate: true },
};

/** Tries the real image; falls back to generative art if it 404s. */
export function ArtImage({ src, alt, fallback, className }: { src: string; alt: string; fallback: ReactNode; className?: string }) {
  const [state, setState] = useState<"loading" | "ok" | "err">("loading");
  return (
    <>
      {state !== "ok" && fallback}
      {state !== "err" && (
        <img
          src={src}
          alt={alt}
          className={className}
          draggable={false}
          onLoad={() => setState("ok")}
          onError={() => setState("err")}
          style={state === "ok" ? undefined : { position: "absolute", opacity: 0, pointerEvents: "none" }}
        />
      )}
    </>
  );
}
