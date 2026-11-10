// Screenshots the four main pages at 1920x1080 into ./shots and reports horizontal overflow at 1920 and 1440.
// Needs the dev server running: bun run dev (override the address with SHOTS_URL).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.SHOTS_URL ?? "http://localhost:8080";
const pages = [
  ["overview", "/"],
  ["map", "/map"],
  ["items", "/items"],
  ["review", "/review"],
];
mkdirSync("shots", { recursive: true });
const browser = await chromium.launch();
let overflow = false;
for (const width of [1920, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: width === 1920 ? 1080 : 900 } });
  for (const [name, path] of pages) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    if (width === 1920) await page.screenshot({ path: `shots/${name}.png` });
    const wide = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const els = [...document.querySelectorAll("body *")].filter(
        (e) => e.getBoundingClientRect().right > w + 1 && !e.closest("[data-scroll-ok]"),
      );
      return {
        scroll: document.documentElement.scrollWidth - w,
        offenders: els.slice(0, 3).map((e) => e.tagName + "." + String(e.className).slice(0, 60)),
      };
    });
    if (wide.scroll > 0) {
      overflow = true;
      console.log(`OVERFLOW ${width} ${name}: ${wide.scroll}px`, wide.offenders);
    } else console.log(`ok ${width} ${name}`);
  }
  await page.close();
}
await browser.close();
process.exit(overflow ? 1 : 0);
