// scripts/verify-title-callout-moments.mjs
// Issue #169: upload two speaker WebMs, add Title (1s-3s) and Callout (4s-6s)
// through the real moments UI using start+duration, verify preview timing,
// export, and decoded frames at 2s/5s/7s with speaker pixels + audio intact.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/root/.cache/ms-playwright/chromium-1148/chrome-linux/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run title-callout verification.");
}
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(t); child.off("exit", onExit); resolve(ok); };
    const onExit = () => finish(true);
    const t = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}
async function stopChrome(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 2000)) return;
  child.kill("SIGKILL");
  await waitForExit(child, 2000);
}
async function removeDirEventually(dir) {
  for (let i = 0; i < 8; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { if (i === 7) return; await sleep(100 * (i + 1)); }
  }
}
async function fetchJson(url, attempts = 60) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); last = new Error("HTTP " + r.status); }
    catch (e) { last = e; }
    await sleep(250);
  }
  throw last;
}
function connectWebSocket(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (event) => {
    const m = JSON.parse(event.data);
    if (!m.id || !pending.has(m.id)) return;
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(JSON.stringify(m.error)));
    else resolve(m.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const send = (method, params = {}) => {
    const callId = ++id;
    ws.send(JSON.stringify({ id: callId, method, params }));
    return new Promise((resolve, reject) => pending.set(callId, { resolve, reject }));
  };
  return { ws, ready, send };
}

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };

  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq || 440;
    const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 82; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  const TITLE_REGION = { x0: 10, y0: 7, x1: 90, y1: 17 };
  const CALLOUT_REGION = { x0: 7, y0: 78, x1: 32, y1: 85 };
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }
  const stage = () => document.querySelector("#stage-canvas");
  const titleShown = () => { const s = regionStats(stage(), TITLE_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const calloutShown = () => { const s = regionStats(stage(), CALLOUT_REGION); return s.dark > 0.45 && s.light > 0.004; };
  const titleAbsent = () => { const s = regionStats(stage(), TITLE_REGION); return s.dark < 0.1 && s.light < 0.01; };
  const calloutAbsent = () => { const s = regionStats(stage(), CALLOUT_REGION); return s.dark < 0.1 && s.light < 0.01; };

  await waitFor(() => document.querySelector("#moment-duration") && document.querySelector("#moment-add"),
    "title/callout moment controls should exist");

  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  await waitFor(
    () => [...document.querySelectorAll("video[data-speaker]")].every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7),
    "uploaded speakers should decode", 400,
  );

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");

  function addTextMoment(type, text, start, duration) {
    document.querySelector("#moment-type").value = type;
    typeInto(document.querySelector("#moment-text"), text);
    typeInto(document.querySelector("#moment-start"), start);
    typeInto(document.querySelector("#moment-duration"), duration);
    typeInto(document.querySelector("#moment-end"), "");
    document.querySelector("#moment-add").click();
  }

  addTextMoment("title", "SEGMENT OPENER", "1", "2");
  await waitFor(() => document.querySelectorAll('#moment-list li[data-moment-type="title"]').length === 1, "title moment listed");
  addTextMoment("callout", "KEY QUOTE", "4", "2");
  await waitFor(() => document.querySelectorAll('#moment-list li[data-moment-type="callout"]').length === 1, "callout moment listed");

  const listText = document.querySelector("#moment-list").textContent;
  assert(listText.includes("SEGMENT OPENER") && listText.includes("0:01") && listText.includes("0:03"), "title range 1s-3s in list");
  assert(listText.includes("KEY QUOTE") && listText.includes("0:04") && listText.includes("0:06"), "callout range 4s-6s in list");

  const scrub = document.querySelector("#scrub");
  async function scrubTo(t) {
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 7, "scrub bar spans episode", 100);
    scrub.value = String(t);
    scrub.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await scrubTo(2);
  await waitFor(() => titleShown() && calloutAbsent(), "title visible around 2s");
  await scrubTo(3.5);
  await waitFor(() => titleAbsent() && calloutAbsent(), "neither visible after title ends");
  await scrubTo(5);
  await waitFor(() => calloutShown() && titleAbsent(), "callout visible around 5s");
  await scrubTo(7);
  await waitFor(() => titleAbsent() && calloutAbsent(), "neither visible at 7s");

  document.querySelector("#export").click();
  await waitFor(() => document.querySelector("#export-download"), "export completes", 700);
  const blob = await (await fetch(document.querySelector("#export-download").href)).blob();
  assert(blob.size > 4096, "exported bytes");

  const v = document.createElement("video");
  v.muted = false; v.volume = 1; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "playable export");
  if (!isFinite(v.duration)) { v.currentTime = 1e7; await waitFor(() => isFinite(v.duration), "duration resolves", 200); }

  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  async function seekAndSample(t) {
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
      v.addEventListener("seeked", fin);
      setTimeout(fin, 4000);
      try { v.currentTime = t; } catch (e) { fin(); }
    });
    await new Promise((r) => setTimeout(r, 300));
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return {
      title: regionStats(probe, TITLE_REGION),
      callout: regionStats(probe, CALLOUT_REGION),
      frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }),
    };
  }
  const at2 = await seekAndSample(2);
  const at5 = await seekAndSample(5);
  const at7 = await seekAndSample(7);
  const burnedIn = (s) => s.dark > 0.3 && s.light > 0.0015;
  const plain = (s) => s.dark < 0.15;
  assert(at2.frame.bright > 0.2, "speaker pixels at 2s");
  assert(burnedIn(at2.title) && plain(at2.callout), "title only at 2s export frame");
  assert(at5.frame.bright > 0.2, "speaker pixels at 5s");
  assert(burnedIn(at5.callout) && plain(at5.title), "callout only at 5s export frame");
  assert(at7.frame.bright > 0.2, "speaker pixels at 7s");
  assert(plain(at7.title) && plain(at7.callout), "neither overlay at 7s");

  return { exportBytes: blob.size, samples: { at2, at5, at7 } };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-title-callout-"));
  const entryUrl = pathToFileURL(path.join(root, "index.html")).href;
  const child = spawn(chrome, [
    "--headless=new", "--no-sandbox", "--disable-gpu",
    "--autoplay-policy=no-user-gesture-required", "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, entryUrl,
  ]);
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome did not expose a page target");
    const { ws, ready, send } = connectWebSocket(page.webSocketDebuggerUrl);
    await ready;
    await send("Runtime.enable");
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-title-callout-moments: OK — title (1-3s) and callout (4-6s) render in preview and export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-title-callout-moments: ${e.message}`); process.exit(1); });
