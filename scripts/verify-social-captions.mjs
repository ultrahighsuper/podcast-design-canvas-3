// scripts/verify-social-captions.mjs
// Drives the shipped app in headless Chrome and proves active step #172 —
// social context improving transcript caption spellings — end to end:
//  * upload two generated speaker WebM videos through the normal controls,
//  * enter distinct Host/Guest social links whose handles imply names
//    (x.com/marcus, x.com/priya),
//  * import a transcript whose caption text MISSPELLS those names
//    ("Marcuss", "Prya"),
//  * confirm the imported caption MOMENTS show the CORRECTED names ("Marcus",
//    "Priya") in the product's own moments list — and the misspellings are gone,
//  * confirm the corrected captions render over the composed preview at their
//    cue times and stay corrected across Split/Stack/Spotlight,
//  * export, load the produced WebM back into a <video>, and confirm it is a
//    playable video with the caption overlay burned in during a captioned
//    moment.
// Media and transcript are generated in-browser and read through the product's
// own controls/download link — no committed fixtures or verifier-only paths.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run social-captions verification.");
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

  // Caption band region: centered lower banner. "Present" = dark backing + light
  // text; "absent" = plain bright video.
  const CAP_REGION = { x0: 41, y0: 82, x1: 59, y1: 88 };
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
  const capShown = () => { const s = regionStats(stage(), CAP_REGION); return s.dark > 0.45 && s.light > 0.003; };
  const captionItems = () => [...document.querySelectorAll("#moment-list li")].filter((li) => li.dataset.momentType === "caption");
  const captionListText = () => captionItems().map((li) => li.querySelector(".moment-text").textContent).join(" | ");

  await waitFor(() => window.PDC && window.PDC.captions && window.PDC.captions.correctSpelling
    && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#caption-file")
    && document.querySelector('[data-link-bucket="host"]') && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped caption/social/export controls should exist");

  // Model check: derived names correct obvious misspellings; unrelated text is
  // left alone.
  {
    const scratch = window.PDC.episode.createEpisode({});
    window.PDC.episode.setSocialLink(scratch, "host", "https://x.com/marcus");
    window.PDC.episode.setSocialLink(scratch, "guest1", "https://x.com/priya");
    const names = window.PDC.captions.speakerNames(scratch);
    assert(names.includes("marcus") && names.includes("priya"), "speakerNames should derive marcus + priya");
    assert(window.PDC.captions.correctSpelling("Welcome Marcuss and Prya", names) === "Welcome Marcus and Priya",
      "correctSpelling should fix both misspellings");
    assert(window.PDC.captions.correctSpelling("the show was great", names) === "the show was great",
      "correctSpelling should not touch unrelated words");
  }

  // The transcript intentionally MISSPELLS the two speaker names.
  const VTT = [
    "WEBVTT", "",
    "00:00:00.000 --> 00:00:03.000", "Welcome Marcuss to the show", "",
    "00:00:04.000 --> 00:00:07.000", "Great to have you Prya", "",
  ].join("\\n");

  // Upload two speaker videos through the normal Host and Guest controls.
  const [host, guest] = await Promise.all([
    makeVideo("host.webm", "#b91c1c", 300),
    makeVideo("guest.webm", "#10b981", 520),
  ]);
  uploadTo(document.querySelector('[data-file-bucket="host"]'), host);
  await sleep(100);
  uploadTo(document.querySelector('[data-file-bucket="guest1"]'), guest);
  await waitFor(() => document.querySelectorAll("video[data-speaker]").length === 2, "two decoder videos should exist");
  const vids = [...document.querySelectorAll("video[data-speaker]")];
  await waitFor(
    () => vids.every((v) => v.readyState >= 2 && isFinite(v.duration) && v.duration >= 7.2),
    "uploaded speakers should decode with a real duration covering both cue ranges", 400,
  );

  // Enter distinct social links whose handles imply distinct names, THEN import
  // the misspelled transcript (order matters: correction uses the current links).
  typeInto(document.querySelector('[data-link-bucket="host"]'), "https://x.com/marcus");
  typeInto(document.querySelector('[data-link-bucket="guest1"]'), "https://x.com/priya");
  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split preset should be active");
  assert(document.querySelector('[data-bucket="host"] .bucket-name').textContent === "marcus", "host name should derive from the link");
  assert(document.querySelector('[data-bucket="guest1"] .bucket-name').textContent === "priya", "guest name should derive from the link");

  uploadTo(document.querySelector("#caption-file"), new File([VTT], "episode.vtt", { type: "text/vtt" }));
  await waitFor(() => /imported/i.test(document.querySelector("#caption-status").textContent || ""), "transcript should import, not reject", 200);
  await waitFor(() => captionItems().length === 2, "two caption moments should appear", 100);

  // CORE ASSERTION: the caption moments use the CORRECTED names, and the raw
  // misspellings are gone — social context improved the transcript spellings.
  const listText = captionListText();
  assert(/\\bMarcus\\b/.test(listText), "caption text should use the corrected 'Marcus': " + listText);
  assert(/\\bPriya\\b/.test(listText), "caption text should use the corrected 'Priya': " + listText);
  assert(!/Marcuss/.test(listText), "the misspelling 'Marcuss' should be gone: " + listText);
  assert(!/Prya/.test(listText), "the misspelling 'Prya' should be gone: " + listText);
  assert(/corrected/i.test(document.querySelector("#caption-status").textContent || ""), "status should note the social-context correction");

  // The corrected caption is visible over the composed preview right away.
  await waitFor(() => capShown(), "corrected caption should render over the preview at the first cue", 160);

  // PLAYBACK: the corrected captions render only inside their cue windows.
  document.querySelector("#restart").click();
  await waitFor(() => capShown(), "caption should appear during playback inside 0-3s", 160);

  // PRESET SWITCHES: corrected caption text stays attached and rendered.
  for (const presetId of ["stack", "spotlight"]) {
    document.querySelector('[data-preset="' + presetId + '"]').click();
    await waitFor(() => stage().dataset.preset === presetId, presetId + " preset should apply");
    const t = captionListText();
    assert(/\\bMarcus\\b/.test(t) && !/Marcuss/.test(t), presetId + ": corrected caption text should persist: " + t);
    const btn = document.querySelector("#play");
    if (btn.textContent.indexOf("Pause") !== -1) btn.click();
    const scrub = document.querySelector("#scrub");
    await waitFor(() => !scrub.disabled && Number(scrub.max) >= 6, "scrub should span the episode", 100);
    scrub.value = "1.5"; scrub.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => capShown(), presetId + ": corrected caption should render at 1.5s");
  }

  document.querySelector('[data-preset="split"]').click();
  await waitFor(() => stage().dataset.preset === "split", "Split should be re-applied before export");

  // EXPORT: produce a real video and confirm it is playable with the caption
  // overlay burned in during a captioned moment.
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled");
  document.querySelector("#export").click();
  await waitFor(
    () => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 700,
  );
  const resultText = document.querySelector("#export-result").textContent || "";
  assert(!/failed/i.test(resultText), "export must not report failure: " + resultText);
  const href = document.querySelector("#export-download").getAttribute("href");
  assert(href && href.indexOf("blob:") === 0, "download link should be a real blob URL");
  const blob = await (await fetch(href)).blob();
  assert(blob.size > 4096, "exported file should carry real bytes, got " + blob.size);

  const v = document.createElement("video");
  v.muted = true; v.src = URL.createObjectURL(blob);
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 5000); });
  assert(v.videoWidth > 0 && v.videoHeight > 0, "exported file should be a playable video with real dimensions");
  if (!isFinite(v.duration)) {
    v.currentTime = 1e7;
    await waitFor(() => isFinite(v.duration), "exported duration should resolve", 200);
  }
  assert(v.duration >= 6.2, "export should cover the caption ranges, duration=" + v.duration);

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
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; resolve(); };
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
      setTimeout(fin, 300);
    });
    probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
    return { caption: regionStats(probe, CAP_REGION), frame: regionStats(probe, { x0: 0, y0: 0, x1: 100, y1: 100 }) };
  }
  const inCue = await seekAndSample(1.5);
  const inGap = await seekAndSample(3.5);
  assert(inCue.frame.bright > 0.2, "exported frame at 1.5s should be nonblank (speaker pixels render)");
  assert(inCue.caption.dark > 0.3 && inCue.caption.light > 0.0015, "caption overlay should be burned in at 1.5s: " + JSON.stringify(inCue.caption));
  assert(inGap.caption.dark < 0.15, "no caption should be burned in at 3.5s: " + JSON.stringify(inGap.caption));

  return {
    hostName: document.querySelector('[data-bucket="host"] .bucket-name').textContent,
    guestName: document.querySelector('[data-bucket="guest1"] .bucket-name').textContent,
    correctedCaptionText: listText,
    captionStatus: document.querySelector("#caption-status").textContent,
    exportBytes: blob.size,
    exportDuration: Number(v.duration.toFixed(2)),
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-social-captions-"));
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
    // 120s budget: two ~8s in-browser media generations, import + playback +
    // preset-switch sampling, one full-length export, and two decode-seeks.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 120000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-social-captions: OK — social-link names correct misspelled caption text in preview and export");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-social-captions: ${e.message}`); process.exit(1); });
