// scripts/verify-riverside-import.mjs
// Drives the shipped app in headless Chrome and proves the Riverside-style link
// import setup path end to end, exactly the way active step #195 is checked:
//  * paste the repo's DECLARED sample Riverside-style manifest link (the exact
//    string shown beside the import field and documented in the README — its
//    episode id resolves to the bundled sample in app/riverside-sample.js:
//    three animated speaker-card tracks embedded as self-contained data:video
//    URLs, so importing performs NO file or network reads and cannot be
//    CORS-blocked in any environment), click Import, and confirm Host, Guest 1,
//    and Guest 2 populate as speaker buckets with real playable media,
//  * sample canvas pixels to confirm all three imported tracks (red host, blue
//    guest 1, green guest 2) compose in the live preview and rerender distinctly
//    across Split, Stack, and Spotlight,
//  * click the real Export action, load the produced WebM back into a <video>,
//    and confirm real dimensions, non-trivial bytes, AND visible decoded frames
//    (seek + draw to a probe canvas and check the imported track colors),
//  * re-import via a generated object-URL link (two in-browser-recorded WebM
//    tracks) to prove the importer is not hard-coded to the bundled sample,
//  * paste an unsupported link and confirm a visible error appears while the
//    imported speaker setup and export readiness remain intact.
// The page is opened over file:// (like the review sandbox). The declared
// sample's tracks are data: URLs, so importing them involves no file reads at
// all — nothing for that environment to block.
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
  throw new Error("Chrome/Chromium was not found. Set CHROME_BIN to run Riverside-import verification.");
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

const DECLARED_SAMPLE_LINK = "https://riverside.fm/studio/pdc-sample-episode";

const browserExpression = `
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const waitFor = async (fn, label, tries) => {
    for (let i = 0; i < (tries || 200); i++) { if (fn()) return; await sleep(50); }
    throw new Error(label);
  };
  const DECLARED = ${JSON.stringify(DECLARED_SAMPLE_LINK)};

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
    for (let i = 0; i < 45; i++) { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); await sleep(100); }
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    osc.stop(); ac.close(); stream.getTracks().forEach((t) => t.stop());
    return new File(chunks, name, { type: "video/webm" });
  }
  const typeInto = (input, v) => { input.value = v; input.dispatchEvent(new Event("input", { bubbles: true })); };

  const stage = () => document.querySelector("#stage-canvas");
  function regionAvg(canvas, xp, yp) {
    const w = canvas.width, h = canvas.height;
    const x = Math.max(0, Math.min(w - 6, Math.round(xp / 100 * w) - 3));
    const y = Math.max(0, Math.min(h - 6, Math.round(yp / 100 * h) - 3));
    const d = canvas.getContext("2d").getImageData(x, y, 6, 6).data;
    let r = 0, g = 0, b = 0; const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return { r: r / n, g: g / n, b: b / n };
  }
  const avgAtPct = (xp, yp) => regionAvg(stage(), xp, yp);
  // Distinct, non-overlapping color predicates (green requires g>b so it can never
  // also match the blue feed — a real discriminator, not a loose threshold).
  const isRed = (p) => p.r > 120 && p.r > p.g + 60 && p.r > p.b + 60;
  const isBlue = (p) => p.b > 120 && p.b > p.r + 60 && p.b > p.g + 40;
  const isGreen = (p) => p.g > 110 && p.g > p.r + 50 && p.g > p.b + 40;
  const decoderCount = () => document.querySelectorAll("video[data-speaker]").length;
  const statusText = () => (document.querySelector("#riverside-status").textContent || "");

  // readyState leaves "loading" only after every classic end-of-body script has
  // executed — i.e. app/ui.js has attached the Import click handler. Gating on
  // elements/PDC alone can win a race mid-parse (before ui.js runs) and click a
  // button that has no listener yet.
  await waitFor(() => document.readyState !== "loading"
    && window.PDC && window.PDC.riverside && window.PDC.riversideSamples && document.querySelector("#riverside-link")
    && document.querySelector("#riverside-import-btn") && document.querySelector("#riverside-status")
    && document.querySelector("#riverside-sample-link") && document.querySelector("#riverside-use-sample")
    && document.querySelector('[data-file-bucket="host"]') && document.querySelector("#export") && document.querySelector("#scrub"),
    "shipped Riverside import + export controls should exist");

  // The sample link shown IN THE PRODUCT must be the declared one this check
  // (and the README) documents — the maintainer pastes exactly this string.
  assert(document.querySelector("#riverside-sample-link").textContent.trim() === DECLARED,
    "the sample link shown beside the import field must match the declared link");
  // Model check: the declared link resolves through the bundled samples
  // registry into three self-contained data:video tracks (no file/network read
  // to CORS-block), and remote media URLs are NOT importable (deferred).
  {
    const m = window.PDC.riverside.parseEpisodeLink(DECLARED);
    assert(m.ok && m.tracks.length === 3 && m.tracks.every((t) => /^data:video\\/webm;base64,/.test(t.url)),
      "the declared link should resolve to the bundled data: sample tracks");
    const bad = window.PDC.riverside.parseEpisodeLink("https://riverside.fm/no-tracks-here");
    assert(!bad.ok && bad.error, "parseEpisodeLink should reject a link with no track urls");
    const remote = window.PDC.riverside.parseEpisodeLink("https://riverside.fm/e?host=https://cdn.example/h.webm&guest1=https://cdn.example/g.webm");
    assert(!remote.ok, "remote http(s) media URLs must not be importable tracks");
  }

  async function waitImported(n, label) {
    await waitFor(() => /imported/i.test(statusText()), label + ": import should report success | status=[" + statusText() + "] error=[" + (document.querySelector("#riverside-error").textContent || "") + "] decoders=" + decoderCount(), 400);
    assert(document.querySelector("#riverside-error").hidden, label + ": no error for a valid link");
    await waitFor(() => decoderCount() === n, label + ": " + n + " speaker decoder videos should exist", 300);
    await waitFor(() => stage().dataset.speakers === String(n), label + ": composed preview should report " + n + " speakers", 200);
    const vids = [...document.querySelectorAll("video[data-speaker]")];
    await waitFor(() => vids.every((v) => v.readyState >= 2 && v.videoWidth > 0), label + ": imported tracks should decode with real frames", 400);
  }
  async function assertPresetComposition(label) {
    document.querySelector('[data-preset="split"]').click();
    await waitFor(() => stage().dataset.preset === "split", label + ": Split should apply");
    await waitFor(() => isRed(avgAtPct(25, 40)), label + " Split: Host (red) fills the left");
    await waitFor(() => isBlue(avgAtPct(75, 22)), label + " Split: Guest 1 (blue) in the top-right");
    await waitFor(() => isGreen(avgAtPct(75, 70)), label + " Split: Guest 2 (green) in the bottom-right");
    document.querySelector('[data-preset="stack"]').click();
    await waitFor(() => stage().dataset.preset === "stack", label + ": Stack should apply");
    await waitFor(() => isRed(avgAtPct(50, 14)), label + " Stack: Host (red) top row");
    await waitFor(() => isBlue(avgAtPct(50, 50)), label + " Stack: Guest 1 (blue) middle row");
    await waitFor(() => isGreen(avgAtPct(50, 84)), label + " Stack: Guest 2 (green) bottom row");
    document.querySelector('[data-preset="spotlight"]').click();
    await waitFor(() => stage().dataset.preset === "spotlight", label + ": Spotlight should apply");
    await waitFor(() => isRed(avgAtPct(35, 50)), label + " Spotlight: Host (red) dominant");
    await waitFor(() => isBlue(avgAtPct(84, 84)) || isGreen(avgAtPct(84, 84)), label + " Spotlight: a guest PiP visible bottom-right");
    document.querySelector('[data-preset="split"]').click();
    await waitFor(() => stage().dataset.preset === "split", label + ": back to Split");
  }

  // ── (1) THE DECLARED SAMPLE LINK — the exact string the maintainer pastes. ──
  typeInto(document.querySelector("#riverside-link"), DECLARED);
  document.querySelector("#riverside-import-btn").click();
  await waitImported(3, "declared-link");
  const bucketText = document.querySelector("#buckets").textContent;
  assert(/host\\.webm/.test(bucketText) && /guest1\\.webm/.test(bucketText) && /guest2\\.webm/.test(bucketText),
    "Host, Guest 1, and Guest 2 buckets should show the imported sample track filenames");
  await assertPresetComposition("declared-link");

  // ── (2) EXPORT: playable file with real dimensions AND visible decoded frames. ──
  await waitFor(() => !document.querySelector("#export").disabled, "Export should be enabled after import");
  document.querySelector("#export").click();
  await waitFor(() => document.querySelector("#export-download") && document.querySelector("#export-playback"),
    "export should produce a downloadable result", 800);
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
  const probe = document.createElement("canvas");
  probe.width = v.videoWidth; probe.height = v.videoHeight;
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", fin); resolve(); };
    v.addEventListener("seeked", fin);
    setTimeout(fin, 4000);
    try { v.currentTime = Math.min(1, Math.max(0.2, v.duration / 2)); } catch (e) { fin(); }
  });
  await new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; resolve(); };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(fin);
    setTimeout(fin, 300);
  });
  probe.getContext("2d").drawImage(v, 0, 0, probe.width, probe.height);
  const exHost = regionAvg(probe, 25, 40);
  const exG1 = regionAvg(probe, 75, 22);
  const exG2 = regionAvg(probe, 75, 70);
  assert(exHost.r + exHost.g + exHost.b > 60, "exported frame should be visibly non-black");
  assert(isRed(exHost), "exported frame should show the imported Host track (red) on the left: " + JSON.stringify(exHost));
  assert(isBlue(exG1), "exported frame should show imported Guest 1 (blue) top-right: " + JSON.stringify(exG1));
  assert(isGreen(exG2), "exported frame should show imported Guest 2 (green) bottom-right: " + JSON.stringify(exG2));

  // ── (3) A generated link (object-URL tracks) imports too — the importer is
  //        not hard-coded to the bundled sample. ──
  const [genHost, genGuest] = await Promise.all([
    makeVideo("live-host.webm", "#d11d1d", 320),
    makeVideo("live-guest.webm", "#1d7dd1", 500),
  ]);
  const genLink = "https://riverside.fm/studio/live-42?host=" + encodeURIComponent(URL.createObjectURL(genHost))
    + "&guest1=" + encodeURIComponent(URL.createObjectURL(genGuest));
  const hostSrcBefore = document.querySelector('video[data-speaker="host"]').src;
  typeInto(document.querySelector("#riverside-link"), genLink);
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => /imported 2 speaker/i.test(statusText()), "generated-link: two tracks should import", 400);
  assert(document.querySelector("#riverside-error").hidden, "generated-link: no error for a valid link");
  const hostVid = document.querySelector('video[data-speaker="host"]');
  assert(hostVid.src && hostVid.src !== hostSrcBefore, "generated-link: the Host decoder should switch to the newly imported track");
  await waitFor(() => hostVid.readyState >= 2 && hostVid.videoWidth > 0, "generated-link: the new Host track should decode", 400);

  // ── (4) "Use sample link" starts the episode in ONE click (active step #204):
  //        it fills the declared link AND imports it, populating Host/Guest 1/
  //        Guest 2 and rendering the preview with NO separate Import click. Prove
  //        it from a cleared episode so the one click is solely responsible. ──
  document.querySelector("#new-episode").click();
  await waitFor(() => decoderCount() === 0, "new episode should clear the imported tracks first");
  await waitFor(() => document.querySelector("#export").disabled, "export disabled on the empty episode");
  document.querySelector("#riverside-use-sample").click();
  assert(document.querySelector("#riverside-link").value.trim() === DECLARED, "Use sample link should fill the declared link");
  await waitImported(3, "use-sample");
  await waitFor(() => !document.querySelector("#export").disabled, "use-sample: Export should be enabled after the one-click import");
  await assertPresetComposition("use-sample");

  // ── (5) UNSUPPORTED LINK: visible error, imported setup NOT wiped. ──
  const beforeCount = decoderCount();
  typeInto(document.querySelector("#riverside-link"), "https://riverside.fm/not-a-real-episode");
  document.querySelector("#riverside-import-btn").click();
  await waitFor(() => !document.querySelector("#riverside-error").hidden && document.querySelector("#riverside-error").textContent.trim(),
    "an unsupported link should show a visible error", 100);
  assert(decoderCount() === beforeCount && beforeCount === 3, "unsupported import must not drop the imported speaker tracks");
  assert(!document.querySelector("#export").disabled, "unsupported import must not disable export");
  await waitFor(() => stage().dataset.speakers === "3", "preview still shows the imported speakers after the failed import");

  return {
    declaredLink: DECLARED,
    importedDecoders: decoderCount(),
    exportBytes: blob.size,
    exportDims: [v.videoWidth, v.videoHeight],
    exportFrameSamples: { host: exHost, guest1: exG1, guest2: exG2 },
    presetsChecked: ["split", "stack", "spotlight"],
    shapesChecked: ["declared sample link (embedded data: episode)", "generated object-URL link", "use-sample helper"],
  };
})()
`;

async function main() {
  const chrome = findChrome();
  const port = await getFreePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pdc-riverside-"));
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
    // 150s budget: fixture imports are fast; the generated-link scenario records
    // two ~5s tracks, plus one full-length export and a decode-seek pass.
    const result = await send("Runtime.evaluate", { expression: browserExpression, awaitPromise: true, returnByValue: true, timeout: 150000 });
    ws.close();
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    console.log("verify-riverside-import: OK — the declared sample Riverside manifest link imports three synced speaker tracks into Host/Guest buckets, composes across Split/Stack/Spotlight, exports a playable video with the imported tracks visible in decoded frames, alternate link shapes import too, and unsupported links error without wiping setup");
    console.log(JSON.stringify(result.result.value, null, 2));
  } finally {
    await stopChrome(child);
    await removeDirEventually(profileDir);
  }
}

main().catch((e) => { console.error(`verify-riverside-import: ${e.message}`); process.exit(1); });
