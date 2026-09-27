import type { CSSProperties } from "react";
import { wifeCandidate } from "../lib/wives";
import { ArtImage, HEAD_VIEWBOX, PERSON_ART, PortraitArt } from "./GenArt";
import "../styles/wife-face.css";

/** Her card's hue, for the ring. Falls back to the app hue. */
export function faceHue(candidateId: string | undefined): number | undefined {
  return candidateId ? PERSON_ART[candidateId]?.hue : undefined;
}

/**
 * A wife's face: the same art as her Eigen dating card (the generated webp
 * when it exists, the procedural portrait otherwise), cropped to a circle
 * with a soft ring in her hue.
 */
export function WifeFace({
  who,
  size = 48,
  glow = false,
  dim = false,
  className = "",
}: {
  who: { candidateId?: string; name?: string };
  size?: number;
  glow?: boolean;
  dim?: boolean;
  className?: string;
}) {
  const c = wifeCandidate(who);
  const hue = faceHue(c?.id);
  const style = { width: size, height: size, ...(hue !== undefined ? { "--wf-hue": hue } : {}) } as CSSProperties;
  return (
    <span className={`wface ${glow ? "glow" : ""} ${dim ? "dim" : ""} ${className}`} style={style} data-candidate={c?.id ?? "none"}>
      <span className="wface-clip">
        {c ? (
          <ArtImage src={c.photos[0]!.src} alt={c.name} className="wface-art" fallback={<PortraitArt id={c.id} name={c.name} className="wface-art" viewBox={HEAD_VIEWBOX} />} />
        ) : (
          <span className="wface-blank">{(who.name ?? "?").slice(0, 1).toUpperCase()}</span>
        )}
      </span>
    </span>
  );
}
