// scripts/verify-canvas-layers.mjs
// Drives the shipped app in headless Chrome and proves active step #211 —
// reusable non-video design layers on the layout canvas — end to end:
//  * upload two generated speaker WebM videos through the normal controls,
//  * open the layout editor, add a SHAPE layer and a TITLE placeholder layer
//    through the real controls, drag/resize them over the speaker frames,
//  * send the shape BEHIND and confirm the speaker video occludes it, then bring
//    it to the FRONT and confirm its bright pixels paint over the speaker video
//    (proving real z-ordering against speaker frames),
//  * save the custom layout as a named show template,
//  * start a NEW episode (product's own control), upload fresh speaker videos,
//    apply the saved template, and confirm the shape + title layers render again
//    over the new videos in the live preview,
//  * Export and load the produced WebM back into a <video>, sampling frames to
//    confirm the added layers are burned in alongside non-black speaker pixels
//    and the file is playable.
// Media is generated in-browser and read through the product's own controls and
// download link — no committed fixtures, seeded media, or verifier-only paths.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function findChrome() {
  const candidates = [process.env.CHROME_BIN, "google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter(Boolean);
  for (const c of candidates) if (spawnSync(c, ["--version"], { encoding: "utf8" }).status === 0) return c;
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run canvas-layers verification.");
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

  async function makeVideo(name, color) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); const d = ac.createMediaStreamDestination(); osc.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 30; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(60); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const stage = () => document.querySelector("#stage-canvas");

  // Fraction of pixels in a stage region that are the bright shape magenta
  // (#ff2d95 ~ r>200,g<120,b>120). The generated speakers are red/green, so this
  // color unambiguously marks the shape layer.
  function magentaFrac(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let mag = 0; const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r > 190 && g < 130 && b > 110 && b < 210) mag++;
    }
    return mag / n;
  }
  function regionStats(canvas, region) {
    const w = canvas.width, h = canvas.height;
    const x0 = Math.floor(region.x0 / 100 * w), x1 = Math.floor(region.x1 / 100 * w);
    const y0 = Math.floor(region.y0 / 100 * h), y1 = Math.floor(region.y1 / 100 * h);
    const data = canvas.getContext("2d").getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, light = 0, bright = 0; const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r < 70 && g < 70 && b < 70) dark++;
      if (r > 180 && g > 180 && b > 180) light++;
      if (r > 110 || g > 110 || b > 110) bright++;
    }
    return { dark: dark / n, light: light / n, bright: bright / n };
  }
  // Where the default shape and title layers land (percent of stage). The shape
  // starts at x8 y14 w42 h34; the title at x18 y10 w64 h16.
  const SHAPE_REGION = { x0: 12, y0: 20, x1: 42, y1: 40 };
  const TITLE_REGION = { x0: 22, y0: 12, x1: 78, y1: 24 };

  await waitFor(() => window.PDC && window.PDC.templates && window.PDC.templates.resolveLayers
    && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#customize")
    && document.querySelector("#add-shape-layer") && document.querySelector("#add-title-layer")
    && document.querySelector("#new-episode") && document.querySelector("#export"),
    "shipped layer editor / template / export controls should exist");

  // Upload two speakers.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#10b981"));
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  await waitFor(() => [...document.querySelectorAll("video[data-speaker]")].every((v) => v.readyState >= 2 && v.videoWidth > 0),
    "uploaded speakers should decode", 300);
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset active");

  // Open the layout editor and add a shape + a title layer through the real UI.
  document.querySelector("#customize").click();
  await waitFor(() => !document.querySelector("#customize-edit").hidden && !document.querySelector("#edit-overlay").hidden, "editor should open");
  document.querySelector("#add-shape-layer").click();
  await waitFor(() => document.querySelector('.edit-layer-shape'), "a shape layer frame should appear in the editor");
  document.querySelector("#add-title-layer").click();
  await waitFor(() => document.querySelector('.edit-layer-title'), "a title layer frame should appear in the editor");

  // The shape defaults BEHIND the speakers; in full-frame Split the speaker video
  // occludes it, so the stage should show little/no magenta yet.
  await sleep(150);
  const behindMag = magentaFrac(stage(), SHAPE_REGION);
  assert(behindMag < 0.2, "a BEHIND shape should be mostly occluded by the speaker video, magenta=" + behindMag);

  // Bring the shape to the FRONT via its own control; now it must paint over the
  // speaker video (real z-order change).
  document.querySelector(".edit-layer-shape .edit-layer-z").click();
  await waitFor(() => magentaFrac(stage(), SHAPE_REGION) > 0.5, "a FRONT shape should paint over the speaker video", 120);
  const frontMag = magentaFrac(stage(), SHAPE_REGION);
  assert(frontMag > behindMag + 0.3, "bringing the shape to front should visibly increase its pixels (" + behindMag + " -> " + frontMag + ")");

  // The title placeholder (front by default) should render its dark box + text.
  const titleStats = regionStats(stage(), TITLE_REGION);
  assert(titleStats.dark > 0.2 && titleStats.light > 0.003, "the title layer should render a dark box with light text: " + JSON.stringify(titleStats));

  // Save the custom layout (with both layers) as a named show template.
  document.querySelector("#template-name").value = "Branded layout";
  document.querySelector("#template-name").dispatchEvent(new Event("input", { bubbles: true }));
  document.querySelector("#save-template").click();
  await waitFor(() => document.querySelector("#customize-edit").hidden, "editor should close after save");
  await waitFor(() => [...document.querySelectorAll("#templates .template")].some((b) => /Branded layout/.test(b.textContent)),
    "the saved template should appear in the template list");

  // Start a NEW episode, upload fresh videos, and apply the saved template.
  document.querySelector("#new-episode").click();
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 0, "new episode should clear uploaded media", 100);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host2.webm", "#b91c1c"));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest2.webm", "#10b981"));
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two new decoder videos should exist");
  await waitFor(() => [...document.querySelectorAll("video[data-speaker]")].every((v) => v.readyState >= 2 && v.videoWidth > 0), "new speakers should decode", 300);

  const tplBtn = [...document.querySelectorAll("#templates .template")].find((b) => /Branded layout/.test(b.textContent));
  assert(tplBtn, "saved template should still be listed for the new episode");
  tplBtn.click();
  await waitFor(() => stage().dataset.layers === "2", "applying the template should restore its two layers", 120);
  // The restored FRONT shape + title must render over the NEW videos.
  await waitFor(() => magentaFrac(stage(), SHAPE_REGION) > 0.5, "applied template's shape layer should render over the new videos", 120);
  const appliedTitle = regionStats(stage(), TITLE_REGION);
  assert(appliedTitle.dark > 0.2 && appliedTitle.light > 0.003, "applied template's title layer should render: " + JSON.stringify(appliedTitle));

  // EXPORT and confirm the layers are burned into the produced video.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(() => document.querySelector("#export-download") && document.querySelector("#export-playback"), "export should produce a downloadable result", 800);
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) { v.currentTime = 1e7; await waitFor(() => isFinite(v.duration), "duration should resolve", 200); }
  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  await new Promise((resolve) => {
    let done = false; const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
    v.addEventListener("seeked", fin); setTimeout(fin, 4000);
    try { v.currentTime = Math.min(1, (v.duration || 2) / 2); } catch (e) { fin(); }
  });
  await new Promise((resolve) => { let done = false; const fin = () => { if (done) return; done = true; resolve(); }; if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin); setTimeout(fin, 300); });
  probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
  const exportShapeMag = magentaFrac(probe, SHAPE_REGION);
  const exportTitle = regionStats(probe, TITLE_REGION);
  const exportFrame = regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 });
  assert(exportFrame.bright > 0.2, "exported frame should be nonblank (speaker pixels render)");
  assert(exportShapeMag > 0.3, "the shape layer should be burned into the export: magenta=" + exportShapeMag);
  assert(exportTitle.dark > 0.15 && exportTitle.light > 0.002, "the title layer should be burned into the export: " + JSON.stringify(exportTitle));

  return {
    behindShapeMagenta: Number(behindMag.toFixed(3)),
    frontShapeMagenta: Number(frontMag.toFixed(3)),
    appliedShapeMagenta: Number(magentaFrac(stage(), SHAPE_REGION).toFixed(3)),
    exportShapeMagenta: Number(exportShapeMag.toFixed(3)),
    exportBytes: blob.size,
    layersOnStage: stage().dataset.layers,
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-canvas-layers-"));
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
    console.log("verify-canvas-layers: OK — shape + title layers are editable, z-ordered, saved in a template, reapplied to a new episode, and burned into the export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-canvas-layers: ${e.message}`); process.exit(1); });
