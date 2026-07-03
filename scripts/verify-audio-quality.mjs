// scripts/verify-audio-quality.mjs
// Drives the shipped app in headless Chrome and proves active step #207 — the
// creator-facing audio quality controls actually affect the exported episode:
//  * upload two generated speaker WebM videos (each carrying a low + mid tone at
//    different levels, so processing choices have something to bite on),
//  * pick a NON-DEFAULT audio quality (Off leveling / Natural clarity / Off noise
//    reduction) through the real controls, switch presets, open and cancel layout
//    customization, and confirm the choice stays selected throughout,
//  * Export and measure the decoded audio RMS of the produced file,
//  * change to a different quality (Strong / Enhanced / Strong) through the real
//    controls, Export AGAIN in the same session, and measure that file's audio,
//  * confirm both files are playable with real dimensions and non-silent audio,
//    and that the two quality choices produce a MEASURABLE audio-output
//    difference (relative RMS difference above a robust threshold).
// Media is generated in-browser and read through the product's own controls and
// download link — no committed fixtures, seeded media, or verifier-only paths.
// Mirrors the CDP harness used by the other rendered checks.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run audio-quality verification.");
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

  // Speaker video whose audio has a low tone (110Hz, below the strong 140Hz
  // noise-reduction highpass) plus a mid tone (900Hz), at a chosen level — so
  // leveling, noise reduction, and clarity all have something measurable to do.
  async function makeVideo(name, color, gainVal) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const o1 = ac.createOscillator(); o1.frequency.value = 110;
    const o2 = ac.createOscillator(); o2.frequency.value = 900;
    const g = ac.createGain(); g.gain.value = gainVal;
    const d = ac.createMediaStreamDestination();
    o1.connect(g); o2.connect(g); g.connect(d); o1.start(); o2.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start(250);
    for (let i = 0; i < 34; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    o1.stop(); o2.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };

  const audioBtn = (setting, value) => document.querySelector('button[data-audio-setting="' + setting + '"][data-audio-value="' + value + '"]');
  const isSelected = (setting, value) => { const b = audioBtn(setting, value); return b && b.getAttribute("aria-pressed") === "true"; };
  function pickQuality(q) {
    audioBtn("leveling", q.leveling).click();
    audioBtn("clarity", q.clarity).click();
    audioBtn("noiseReduction", q.noiseReduction).click();
  }
  function assertSelected(q, label) {
    assert(isSelected("leveling", q.leveling), label + ": leveling " + q.leveling + " should be selected");
    assert(isSelected("clarity", q.clarity), label + ": clarity " + q.clarity + " should be selected");
    assert(isSelected("noiseReduction", q.noiseReduction), label + ": noiseReduction " + q.noiseReduction + " should be selected");
  }

  // Export via the real Export button and measure the produced file's audio RMS.
  async function exportAndMeasure(label) {
    const before = document.querySelector("#export-download");
    document.querySelector("#export").click();
    await waitFor(() => {
      const d = document.querySelector("#export-download");
      return d && d !== before && document.querySelector("#export-playback");
    }, label + ": export should produce a fresh downloadable result", 800);
    const resultText = document.querySelector("#export-result").textContent || "";
    assert(!/failed/i.test(resultText), label + ": export must not report failure: " + resultText);
    const href = document.querySelector("#export-download").getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, label + ": download should be a real blob URL");
    const bytes = await (await fetch(href)).arrayBuffer();
    assert(bytes.byteLength > 4096, label + ": exported file should carry real bytes, got " + bytes.byteLength);

    // Decode audio and measure RMS.
    let rms = 0;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const audio = await ac.decodeAudioData(bytes.slice(0));
    let sum = 0, cnt = 0;
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch);
      for (let i = 0; i < data.length; i += 4) { sum += data[i] * data[i]; cnt++; }
    }
    rms = Math.sqrt(sum / Math.max(1, cnt));
    await ac.close();

    // Confirm the produced file is a genuinely playable video.
    const v = document.createElement("video");
    v.muted = true; v.src = URL.createObjectURL(new Blob([bytes], { type: "video/webm" }));
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, label + ": exported file should be a playable video with real dimensions");

    return { rms, bytes: bytes.byteLength, dims: v.videoWidth + "x" + v.videoHeight };
  }

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]')
    && document.querySelector('button[data-audio-setting="leveling"]') && document.querySelector("#export")
    && document.querySelector("#customize") && document.querySelector("#cancel-customize"),
    "shipped audio-quality/customize/export controls should exist");

  // Upload two speakers with clearly different audio levels.
  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c", 0.9));
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#10b981", 0.3));
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(() => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 2.8),
    "uploaded speakers should decode with real audio", 400);
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => document.querySelector("#stage-canvas").dataset.preset === "split", "Split preset should be active");
  // Keep the composition composing live audio/video while we capture.
  const play = document.querySelector("#play");
  if (play.textContent.indexOf("Pause") === -1) play.click();

  // (1) Pick a non-default quality and confirm it PERSISTS through a preset
  //     switch and through opening + cancelling layout customization.
  const QUIET = { leveling: "off", clarity: "natural", noiseReduction: "off" };
  pickQuality(QUIET);
  assertSelected(QUIET, "after picking");
  document.querySelector('[data-preset="stack"]').click();
  await waitFor(() => document.querySelector("#stage-canvas").dataset.preset === "stack", "Stack preset should apply");
  assertSelected(QUIET, "after preset switch");
  document.querySelector("#customize").click();
  await waitFor(() => !document.querySelector("#customize-edit").hidden, "customize editor should open");
  document.querySelector("#cancel-customize").click();
  await waitFor(() => document.querySelector("#customize-edit").hidden, "customize editor should close on cancel");
  assertSelected(QUIET, "after customize cancel");
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => document.querySelector("#stage-canvas").dataset.preset === "split", "back to Split for export");

  // (2) Export with the quiet/minimal quality.
  const quiet = await exportAndMeasure("minimal-quality");
  assert(quiet.rms > 0.003, "minimal export should have non-silent audio, rms=" + quiet.rms);

  // (3) Change to a strong quality and export AGAIN in the same session.
  const STRONG = { leveling: "strong", clarity: "enhanced", noiseReduction: "strong" };
  pickQuality(STRONG);
  assertSelected(STRONG, "after switching to strong");
  const strong = await exportAndMeasure("strong-quality");
  assert(strong.rms > 0.003, "strong export should still have non-silent audio (repeat export), rms=" + strong.rms);

  // (4) The two quality choices must produce a measurable audio difference.
  const relDiff = Math.abs(quiet.rms - strong.rms) / Math.max(quiet.rms, strong.rms);
  assert(relDiff > 0.08, "audio quality choice should measurably change the exported audio, relDiff=" + relDiff
    + " (minimal rms=" + quiet.rms + ", strong rms=" + strong.rms + ")");

  return {
    minimal: quiet,
    strong: strong,
    relDiff: Number(relDiff.toFixed(4)),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-audio-quality-"));
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
    // 120s budget: two ~3.4s in-browser media generations, two full-length
    // exports with audio decoding, plus preset/customize interaction.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-audio-quality: OK — audio quality choice persists through preset/customize and measurably changes the exported audio");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-quality: ${e.message}`); process.exit(1); });
