// tests/captions.test.mjs — transcript caption import: WebVTT/SRT parsing and
// turning cues into timed CAPTION MOMENTS on the episode (via app/moments.js),
// including idempotent re-import, preservation of other moments, and leaving the
// episode untouched on invalid input.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const C = PDC.captions;
const M = PDC.moments;
const E = PDC.episode;

const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.000 --> 00:00:03.000",
  "Welcome to the show",
  "",
  "2",
  "00:00:04.000 --> 00:00:07.500",
  "Today we talk about <b>captions</b>",
  "",
].join("\n");

const SRT = [
  "1",
  "00:00:00,000 --> 00:00:03,000",
  "Welcome to the show",
  "",
  "2",
  "00:00:04,000 --> 00:00:07,500",
  "Today we talk about captions",
  "",
].join("\n");

test("parseTimestamp accepts VTT and SRT timestamp forms", () => {
  assert.equal(C.parseTimestamp("00:00:03.000"), 3);
  assert.equal(C.parseTimestamp("00:00:03,000"), 3, "SRT comma millis");
  assert.equal(C.parseTimestamp("00:01:05.500"), 65.5);
  assert.equal(C.parseTimestamp("01:00:00.000"), 3600);
  assert.equal(C.parseTimestamp("02:30.250"), 150.25, "mm:ss.mmm");
  assert.ok(Number.isNaN(C.parseTimestamp("nope")));
});

test("parseTranscript reads WebVTT, strips markup, sorts by start", () => {
  const { cues, error } = C.parseTranscript(VTT);
  assert.equal(error, "");
  assert.deepEqual(cues, [
    { start: 0, end: 3, text: "Welcome to the show" },
    { start: 4, end: 7.5, text: "Today we talk about captions" },
  ]);
});

test("parseTranscript reads SRT (no WEBVTT header, comma millis, numeric ids)", () => {
  const { cues, error } = C.parseTranscript(SRT);
  assert.equal(error, "");
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 3, text: "Welcome to the show" });
});

test("parseTranscript tolerates BOM, cue settings, and header sharing a block", () => {
  assert.equal(C.parseTranscript("﻿WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nBom").cues.length, 1);
  assert.deepEqual(
    C.parseTranscript("WEBVTT\n\n00:00:01.000 --> 00:00:04.000 line:85% align:center\nPositioned").cues,
    [{ start: 1, end: 4, text: "Positioned" }],
  );
  assert.deepEqual(
    C.parseTranscript("WEBVTT\n00:00:01.000 --> 00:00:04.000\nRight after header").cues,
    [{ start: 1, end: 4, text: "Right after header" }],
  );
});

test("parseTranscript rejects text with no timed cues", () => {
  const { cues, error } = C.parseTranscript("just notes\nno timings here");
  assert.equal(cues.length, 0);
  assert.match(error, /no timed cues/i);
});

test("importCaptionMoments creates caption-type moments on the episode", () => {
  const ep = E.createEpisode({});
  const result = C.importCaptionMoments(ep, VTT);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  const caps = M.listMoments(ep).filter((m) => m.type === "caption");
  assert.equal(caps.length, 2);
  assert.deepEqual(caps.map((m) => m.text), ["Welcome to the show", "Today we talk about captions"]);
  assert.deepEqual(caps.map((m) => [m.start, m.end]), [[0, 3], [4, 7.5]]);
  // Caption moments are start-inclusive / end-exclusive like every moment.
  assert.deepEqual(M.activeMoments(ep, 1.5).map((m) => m.text), ["Welcome to the show"]);
  assert.deepEqual(M.activeMoments(ep, 3).map((m) => m.text), []);
  assert.deepEqual(M.activeMoments(ep, 5).map((m) => m.text), ["Today we talk about captions"]);
});

test("re-importing replaces caption moments but keeps manual moments", () => {
  const ep = E.createEpisode({});
  const title = M.addMoment(ep, { type: "title", text: "EP TITLE", start: 0, end: 2 });
  C.importCaptionMoments(ep, VTT);
  assert.equal(M.listMoments(ep).length, 3, "title + two captions");
  // Re-import a different transcript: caption moments are replaced, title kept.
  const again = C.importCaptionMoments(ep, "WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nOnly one now");
  assert.equal(again.count, 1);
  const caps = C.captionMoments(ep);
  assert.deepEqual(caps.map((m) => m.text), ["Only one now"]);
  assert.ok(M.listMoments(ep).some((m) => m.id === title.id && m.type === "title"), "manual title survives");
  assert.equal(M.listMoments(ep).length, 2, "title + one caption");
});

test("invalid transcript changes nothing on the episode and returns a reason", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "callout", text: "keep me", start: 1, end: 2 });
  C.importCaptionMoments(ep, VTT);
  const before = JSON.stringify(M.listMoments(ep));
  const result = C.importCaptionMoments(ep, "not a caption file at all");
  assert.equal(result.ok, false);
  assert.match(result.error, /no timed cues|caption/i);
  assert.equal(JSON.stringify(M.listMoments(ep)), before, "episode moments unchanged after a bad import");
});

test("caption moments survive preset and template switches (they are moments)", () => {
  const ep = E.createEpisode({});
  C.importCaptionMoments(ep, VTT);
  const before = JSON.stringify(C.captionMoments(ep));
  for (const preset of ["stack", "spotlight", "split"]) {
    E.setPreset(ep, preset);
    assert.equal(JSON.stringify(C.captionMoments(ep)), before, `captions unchanged on ${preset}`);
  }
  const tpl = PDC.templates.saveTemplate("Custom", { host: { x: 0, y: 0, w: 50, h: 100 } });
  E.setPreset(ep, tpl.id);
  assert.equal(JSON.stringify(C.captionMoments(ep)), before, "captions unchanged on a custom template");
});

test("resetEpisode clears imported caption moments", () => {
  const ep = E.createEpisode({});
  C.importCaptionMoments(ep, VTT);
  E.resetEpisode(ep, { title: "fresh" });
  assert.equal(C.captionMoments(ep).length, 0);
});

// --- Social-context spelling correction (issue #172) -----------------------

test("speakerNames derives correction targets only from buckets that have a link", () => {
  const ep = E.createEpisode({});
  assert.deepEqual(C.speakerNames(ep), [], "no links -> no names");
  E.setSocialLink(ep, "host", "https://x.com/marcus");
  E.setSocialLink(ep, "guest1", "@priya");
  const names = C.speakerNames(ep);
  assert.ok(names.includes("marcus"), "host handle derived");
  assert.ok(names.includes("priya"), "guest handle derived");
});

test("speakerNames splits camelCase / separated handles into name candidates", () => {
  const ep = E.createEpisode({});
  E.setSocialLink(ep, "host", "https://www.linkedin.com/in/sarah-chen");
  const names = C.speakerNames(ep);
  assert.ok(names.includes("sarah") && names.includes("chen"), "sub-names derived: " + names.join(","));
});

test("correctSpelling fixes obvious misspellings and keeps capitalization", () => {
  const names = ["marcus", "priya"];
  assert.equal(C.correctSpelling("Welcome Marcuss to the show", names), "Welcome Marcus to the show");
  assert.equal(C.correctSpelling("Thanks Prya for joining", names), "Thanks Priya for joining");
  assert.equal(C.correctSpelling("MARCAS is here", names), "MARCUS is here", "all-caps stays all-caps");
});

test("correctSpelling leaves correct spellings and unrelated words untouched", () => {
  const names = ["marcus", "priya"];
  assert.equal(C.correctSpelling("Marcus and Priya discuss markets", names), "Marcus and Priya discuss markets");
  assert.equal(C.correctSpelling("the show was great", names), "the show was great", "no over-correction");
  assert.equal(C.correctSpelling("anything", []), "anything", "no names -> no change");
});

test("importCaptionMoments corrects caption text from social links, and reports how many", () => {
  const ep = E.createEpisode({});
  E.setSocialLink(ep, "host", "https://x.com/marcus");
  E.setSocialLink(ep, "guest1", "https://x.com/priya");
  const vtt = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:03.000",
    "Welcome Marcuss to the podcast",
    "",
    "00:00:04.000 --> 00:00:07.000",
    "Great to have you Prya",
    "",
  ].join("\n");
  const result = C.importCaptionMoments(ep, vtt);
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.corrected, 2, "both cues had a corrected name");
  const caps = C.captionMoments(ep);
  assert.deepEqual(caps.map((m) => m.text), ["Welcome Marcus to the podcast", "Great to have you Priya"]);
  // The corrected text is what renders and survives a preset switch.
  E.setPreset(ep, "spotlight");
  assert.equal(C.captionMoments(ep)[0].text, "Welcome Marcus to the podcast");
});

test("importCaptionMoments without social links imports transcript text verbatim", () => {
  const ep = E.createEpisode({});
  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nWelcome Marcuss to the podcast";
  const result = C.importCaptionMoments(ep, vtt);
  assert.equal(result.corrected, 0);
  assert.equal(C.captionMoments(ep)[0].text, "Welcome Marcuss to the podcast", "no links -> no correction");
});
