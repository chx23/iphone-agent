import { describe, expect, it } from "vitest";
import { parseVisionResult } from "./visionClient";

describe("VisionClient parsing", () => {
  it("parses OCR blocks into screen elements", () => {
    const result = parseVisionResult(JSON.stringify({
      summary: "home screen",
      pageType: "wechat_home",
      mainRegions: ["top bar", "chat list"],
      inputHints: ["Search"],
      riskHints: ["Pay"],
      recommendedObservation: "verify current tab",
      ocrBlocks: [
        { text: "Search", role: "button", x: 10, y: 20, width: 100, height: 40, confidence: 0.9, clickable: true }
      ]
    }));

    expect(result?.summary).toBe("home screen");
    expect(result?.pageType).toBe("wechat_home");
    expect(result?.mainRegions).toEqual(["top bar", "chat list"]);
    expect(result?.inputHints).toEqual(["Search"]);
    expect(result?.riskHints).toEqual(["Pay"]);
    expect(result?.recommendedObservation).toBe("verify current tab");
    expect(result?.ocrBlocks).toHaveLength(1);
    expect(result?.ocrBlocks[0].source).toBe("ocr");
    expect(result?.ocrBlocks[0].label).toBe("Search");
    expect(result?.ocrBlocks[0].bounds?.width).toBe(100);
  });

  it("parses compact VLM JSON keys and honors max block limits", () => {
    const result = parseVisionResult(JSON.stringify({
      page: "dialog",
      sum: "permission dialog",
      regions: ["modal"],
      inputs: ["none"],
      risks: ["允许"],
      observe: "verify dialog title",
      els: [
        { t: "允许", r: "button", x: 100, y: 200, w: 180, h: 60, conf: 0.88, c: true },
        { t: "拒绝", r: "button", x: 330, y: 200, w: 180, h: 60, conf: 0.84, c: true }
      ]
    }), { maxBlocks: 1 });

    expect(result?.summary).toBe("permission dialog");
    expect(result?.pageType).toBe("dialog");
    expect(result?.mainRegions).toEqual(["modal"]);
    expect(result?.riskHints).toEqual(["允许"]);
    expect(result?.recommendedObservation).toBe("verify dialog title");
    expect(result?.ocrBlocks).toHaveLength(1);
    expect(result?.ocrBlocks[0].label).toBe("允许");
    expect(result?.ocrBlocks[0].bounds?.width).toBe(180);
  });
});
