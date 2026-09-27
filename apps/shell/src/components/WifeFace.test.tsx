import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CANDIDATES } from "@eigenwife/protocol";
import { faceHue, WifeFace } from "./WifeFace";

describe("WifeFace", () => {
  test("every Act I girl renders her card art as a circle with her hue", () => {
    for (const c of CANDIDATES) {
      const html = renderToStaticMarkup(<WifeFace who={{ candidateId: c.id }} size={40} />);
      expect(html).toContain(`data-candidate="${c.id}"`);
      expect(html).toContain(`src="/candidates/${c.id}-1.webp"`);
      expect(html).toContain(`illustrated portrait of ${c.name}`);
      expect(html).toContain(`--wf-hue:${faceHue(c.id)}`);
      expect(html).toContain("width:40px");
    }
  });

  test("glow and dim states, and a harmless blank for unknown wives", () => {
    expect(renderToStaticMarkup(<WifeFace who={{ name: "Kit" }} glow />)).toContain("wface glow");
    expect(renderToStaticMarkup(<WifeFace who={{ candidateId: "hana" }} dim />)).toContain("dim");
    const blank = renderToStaticMarkup(<WifeFace who={{ name: "Miso" }} />);
    expect(blank).toContain('data-candidate="none"');
    expect(blank).toContain(">M<");
  });
});
