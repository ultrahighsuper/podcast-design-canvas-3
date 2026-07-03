// scripts/verify-audio-quality.mjs
// Drives the shipped app in headless Chrome and proves active step #207: the
// creator-facing audio quality controls actually, measurably change the exported
// audio, and the chosen setting survives the normal workflow.
//
// Faithful to the step's verification contract:
//   * upload two generated local WebM speaker videos (each carrying audio),
//   * select a NON-DEFAULT audio quality option, switch presets, open and cancel
//     layout customization, and confirm the chosen option is STILL selected
//     (it must persist through preset switches and customization cancel),
//   * click the real Export action; re-open the produced file in a <video> and
//     confirm real dimensions, non-trivial bytes, and NON-SILENT decoded audio,
//   * repeat in the SAME session with a DIFFERENT audio quality option and
//     export again — the second file is playable, still non-silent, and the
//     measured loudness differs from the first in a way CONSISTENT with the
//     selected leveling (Strong is measurably louder than Off).
//
// No fixtures, seeded media, or verifier-only product paths: media is generated
// in-browser, options are chosen by clicking the real controls, and every
// artifact is read from the product's own download link. Mirrors the CDP harness
// the other rendered checks use; opened over file:// like the review sandbox.
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
  const waitFor = async (fn, label, tries) => { for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); } throw new Error(label); };

  // A speaker clip carrying a steady tone (distinct per speaker so the two mixed
  // feeds do not phase-cancel). Content is irrelevant to the loudness knob under
  // test — the makeup gain lifts the whole mix regardless of spectrum.
  async function makeVideo(name, color, freq) {
    const canvas = document.createElement("canvas");
    canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(12);
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.type = "sawtooth"; osc.frequency.value = freq || 220;
    const g = ac.createGain(); g.gain.value = 0.4;
    const d = ac.createMediaStreamDestination();
    osc.connect(g); g.connect(d); osc.start();
    const mix = new MediaStream([...stream.getVideoTracks(), ...d.stream.getAudioTracks()]);
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus") ? "video/webm;codecs=vp8,opus" : "video/webm";
    const rec = new MediaRecorder(mix, { mimeType });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.start();
    for (let i = 0; i < 30; i++) { ctx.fillStyle = color; ctx.fillRect(0,0,320,180); ctx.fillStyle="#fff"; ctx.font="26px sans-serif"; ctx.fillText("frame "+i, 20, 100); await sleep(60); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const uploadTo = (input, file) => { const dt = new DataTransfer(); dt.items.add(file); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true })); };
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };
  const pressed = (setting, value) => document.querySelector('[data-audio-setting="' + setting + '"][data-audio-value="' + value + '"]').getAttribute("aria-pressed") === "true";
  function chooseQuality(q) {
    for (const setting of Object.keys(q)) {
      document.querySelector('[data-audio-setting="' + setting + '"][data-audio-value="' + q[setting] + '"]').click();
    }
  }
  function assertQualitySelected(q, label) {
    for (const setting of Object.keys(q)) {
      assert(pressed(setting, q[setting]), label + ": " + setting + "=" + q[setting] + " should be the selected option");
    }
  }

  // Decode an exported blob's audio and return RMS (loudness) + peak. Throws if
  // the file carries no decodable audio track (the silent-export regression).
  async function measureAudio(blob, label) {
    const buf = await blob.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await ac.decodeAudioData(buf.slice(0));
      let sumSq = 0, n = 0, peak = 0;
      for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
        const data = decoded.getChannelData(ch);
        for (let i = 0; i < data.length; i += 7) { const a = data[i]; sumSq += a * a; if (Math.abs(a) > peak) peak = Math.abs(a); n++; }
      }
      const rms = n ? Math.sqrt(sumSq / n) : 0;
      return { rms: rms, peak: peak, samples: decoded.length, seconds: decoded.duration };
    } catch (e) {
      throw new Error(label + ": exported file has no decodable audio track (" + e.name + ")");
    } finally { ac.close(); }
  }

  // Choose a quality option, then run it through the normal workflow BEFORE
  // exporting: switch preset, open + cancel layout customization, and confirm the
  // audio choice is still selected. Then click the real Export and measure it.
  async function exportWithQuality(q, presetId, label) {
    chooseQuality(q);
    assertQualitySelected(q, label + " (immediately after choosing)");
    // Switch preset — the choice must survive it.
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => document.querySelector("#stage-canvas").dataset.preset === presetId, label + ": preset " + presetId + " should apply");
    assertQualitySelected(q, label + " (after preset switch)");
    // Open + cancel layout customization — the choice must survive it too.
    document.querySelector("#customize").click();
    await waitFor(() => !document.querySelector("#customize-edit").hidden, label + ": layout editor should open");
    document.querySelector("#cancel-customize").click();
    await waitFor(() => document.querySelector("#customize-edit").hidden, label + ": layout editor should close on cancel");
    assertQualitySelected(q, label + " (after customize + cancel)");

    const result = document.querySelector("#export-result");
    result.hidden = true; result.innerHTML = "";
    await waitFor(() => !document.querySelector("#export").disabled, label + ": Export should be enabled");
    document.querySelector("#export").click();
    await waitFor(() => document.querySelector("#export-download") && document.querySelector("#export-playback"), label + ": export should produce a downloadable result", 800);
    const href = document.querySelector("#export-download").getAttribute("href");
    assert(href && href.indexOf("blob:") === 0, label + ": download link should be a real blob URL");
    const blob = await (await fetch(href)).blob();
    assert(blob.size > 2048, label + ": exported file should carry real bytes, got " + blob.size);
    const v = document.createElement("video");
    v.muted = true; v.src = URL.createObjectURL(blob);
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
    assert(v.videoWidth > 0 && v.videoHeight > 0, label + ": exported file should be a playable video with real dimensions");
    const audio = await measureAudio(blob, label);
    assert(audio.samples > 0 && audio.peak > 1e-4, label + ": exported audio must be audible (non-silent), peak=" + audio.peak);
    return { bytes: blob.size, dimensions: v.videoWidth + "x" + v.videoHeight, rms: Number(audio.rms.toFixed(5)), peak: Number(audio.peak.toFixed(4)), audioSeconds: Number(audio.seconds.toFixed(2)) };
  }

  await waitFor(() => window.PDC && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#export") && document.querySelector('[data-audio-setting="leveling"][data-audio-value="strong"]'), "shipped controls should exist");

  uploadTo(document.querySelector('[data-file-bucket="host"]'), await makeVideo("host.webm", "#b91c1c", 180));
  await sleep(120);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), await makeVideo("guest.webm", "#047857", 275));
  await sleep(1200);
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/hostperson");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/guestperson");

  // Quiet profile: no leveling makeup, no clarity/noise processing.
  const QUIET = { leveling: "off", clarity: "natural", noiseReduction: "off" };
  // Studio profile: strong leveling (loudness makeup) + enhanced clarity + strong
  // noise reduction. Its exported loudness must be measurably higher than QUIET.
  const STUDIO = { leveling: "strong", clarity: "enhanced", noiseReduction: "strong" };

  const quiet = await exportWithQuality(QUIET, "stack", "quiet/off");
  const studio = await exportWithQuality(STUDIO, "split", "studio/strong");

  // A measurable audio output difference, consistent with the selected setting:
  // Strong leveling is audibly (and here numerically) louder than Off. A generous
  // margin so ordinary encode/timing jitter can never explain it.
  const ratio = studio.rms / Math.max(1e-6, quiet.rms);
  assert(studio.rms > quiet.rms, "Strong leveling should export LOUDER audio than Off (studio rms " + studio.rms + " vs quiet rms " + quiet.rms + ")");
  assert(ratio >= 1.2, "the two audio-quality choices should differ measurably in loudness (rms ratio " + ratio.toFixed(3) + " should be >= 1.2)");

  return {
    quiet: quiet,
    studio: studio,
    rmsRatio: Number(ratio.toFixed(3)),
    persistedThrough: ["preset switch", "layout customization cancel"],
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
    // 90s budget: two full record+decode export passes plus in-browser media setup.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 90000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-audio-quality: OK — the audio-quality choice survives preset switches and layout-customization cancel, and two different choices export playable, non-silent videos whose measured loudness differs consistently with the selected leveling (Strong louder than Off)");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-audio-quality: ${e.message}`); process.exit(1); });
