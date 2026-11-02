import { chromium } from "playwright-core";
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto("file://" + process.cwd() + "/subtitle.html");
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: "subtitle.png", omitBackground: true });
await b.close();
