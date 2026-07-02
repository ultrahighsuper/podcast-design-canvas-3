// tests/captions.test.mjs — WebVTT import model: parse cues, schedule them on
// the [start, end) timeline, and keep them attached to the episode across
// preset switches. DOM-free, zero-dependency (node:test).
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const C = PDC.captions;
const E = PDC.episode;

const SAMPLE = [
  "WEBVTT",
  "",
  "1",
  "00:00:00.000 --> 00:00:03.000",
  "Welcome to the show",
  "",
  "2",
  "00:00:04.000 --> 00:00:07.000",
  "Our guest today",
  "is a designer",
  "",
].join("\n");

test("parseVtt reads HH:MM:SS.mmm cues in order with multi-line text", () => {
  const cues = C.parseVtt(SAMPLE);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 3, text: "Welcome to the show" });
  assert.equal(cues[1].start, 4);
  assert.equal(cues[1].end, 7);
  assert.equal(cues[1].text, "Our guest today\nis a designer");
});

test("parseVtt accepts MM:SS.mmm, comma millis, and cue settings after the end time", () => {
  const vtt = [
    "WEBVTT",
    "",
    "01:30.500 --> 01:33,000 align:start position:10%",
    "Later in the episode",
    "",
  ].join("\n");
  const cues = C.parseVtt(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].start, 90.5);
  assert.equal(cues[0].end, 93);
  assert.equal(cues[0].text, "Later in the episode");
});

test("parseVtt skips NOTE blocks, strips inline tags, and drops invalid timings", () => {
  const vtt = [
    "WEBVTT",
    "",
    "NOTE this is a comment block, not a cue",
    "",
    "00:00:01.000 --> 00:00:02.000",
    "<b>Bold</b> <c.yellow>text</c>",
    "",
    "00:00:05.000 --> 00:00:05.000", // zero-length: dropped
    "empty range",
    "",
    "not-a-timestamp --> also-not",
    "garbage",
    "",
  ].join("\n");
  const cues = C.parseVtt(vtt);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, "Bold text");
});

test("parseVtt sorts cues by start time and never throws on junk", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:06.000 --> 00:00:08.000",
    "second",
    "",
    "00:00:01.000 --> 00:00:03.000",
    "first",
    "",
  ].join("\n");
  const cues = C.parseVtt(vtt);
  assert.deepEqual(cues.map((c) => c.text), ["first", "second"]);
  assert.deepEqual(C.parseVtt(""), []);
  assert.deepEqual(C.parseVtt(null), []);
  assert.deepEqual(C.parseVtt("WEBVTT\n\nno cues here at all"), []);
});

test("parseVtt tolerates real-world WebVTT shapes a caption tool emits", () => {
  const variants = {
    "MM:SS.mmm short form": "WEBVTT\n\n00:01.000 --> 00:03.000\nShort\n\n00:04.000 --> 00:06.000\nSecond",
    "CRLF line endings": "WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nWin\r\n\r\n00:00:04.000 --> 00:00:06.000\r\nSecond",
    "BOM prefix": "﻿WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBom\n\n00:00:04.000 --> 00:00:06.000\nSecond",
    "header title + NOTE": "WEBVTT - Episode 7\n\nNOTE a comment\n\n00:00:01.000 --> 00:00:03.000\nTitled\n\n00:00:04.000 --> 00:00:06.000\nSecond",
    "cue settings after end": "WEBVTT\n\n00:00:01.000 --> 00:00:03.000 align:middle line:90%\nSettings\n\n00:00:04.000 --> 00:00:06.000\nSecond",
    "no millis": "WEBVTT\n\n00:00:01 --> 00:00:03\nNoMillis\n\n00:00:04 --> 00:00:06\nSecond",
    "hours present": "WEBVTT\n\n01:00:01.000 --> 01:00:03.000\nHour\n\n01:00:04.000 --> 01:00:06.000\nSecond",
    "tight and spaced arrows": "WEBVTT\n\n00:00:01.000-->00:00:03.000\nTight\n\n00:00:04.000  -->  00:00:06.000\nSpaced",
  };
  for (const [name, vtt] of Object.entries(variants)) {
    const cues = C.parseVtt(vtt);
    assert.ok(cues.length >= 2, name + ": should yield at least two cues, got " + cues.length);
    assert.ok(cues[0].text && cues[0].end > cues[0].start, name + ": first cue should be well-formed");
  }
  assert.equal(C.parseVtt("WEBVTT\n\n01:00:01.000 --> 01:00:03.000\nHour")[0].start, 3601, "hours convert to seconds");
});

test("importVtt attaches cues to the episode; empty input is rejected and non-destructive", () => {
  const ep = E.createEpisode({});
  assert.equal(C.hasCaptions(ep), false);
  const ok = C.importVtt(ep, "show.vtt", SAMPLE);
  assert.equal(ok.ok, true);
  assert.equal(ok.count, 2);
  assert.equal(C.hasCaptions(ep), true);
  assert.equal(C.getCaptions(ep).name, "show.vtt");

  const bad = C.importVtt(ep, "empty.vtt", "WEBVTT\n\n(nothing)");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /WebVTT/);
  assert.equal(C.getCaptions(ep).name, "show.vtt", "a failed import keeps the previous captions");
  assert.equal(C.getCaptions(ep).cues.length, 2);
});

test("activeCues / activeText follow [start, end) — start inclusive, end exclusive", () => {
  const ep = E.createEpisode({});
  C.importVtt(ep, "show.vtt", SAMPLE);
  assert.equal(C.activeText(ep, 0), "Welcome to the show", "cue active at exactly its start");
  assert.equal(C.activeText(ep, 2.9), "Welcome to the show");
  assert.equal(C.activeText(ep, 3), "", "end is exclusive");
  assert.equal(C.activeText(ep, 3.5), "", "gap between cues shows nothing");
  assert.equal(C.activeText(ep, 4), "Our guest today\nis a designer");
  assert.equal(C.activeText(ep, 7), "", "gone at/after end");
  assert.deepEqual(C.activeCues(ep, 1.5).map((c) => c.text), ["Welcome to the show"]);
  assert.deepEqual(C.activeCues(ep, 3.5), []);
});

test("captions survive a preset switch and are cleared by clearCaptions", () => {
  const ep = E.createEpisode({});
  C.importVtt(ep, "show.vtt", SAMPLE);
  E.setPreset(ep, "spotlight");
  assert.equal(ep.presetId, "spotlight");
  assert.equal(C.hasCaptions(ep), true, "switching layout keeps the imported captions");
  assert.equal(C.activeText(ep, 1), "Welcome to the show");
  C.clearCaptions(ep);
  assert.equal(C.hasCaptions(ep), false);
  assert.equal(C.getCaptions(ep), null);
});

test("resetEpisode (start new episode) drops the caption track", () => {
  const ep = E.createEpisode({});
  C.importVtt(ep, "show.vtt", SAMPLE);
  assert.equal(C.hasCaptions(ep), true);
  E.resetEpisode(ep, { title: "Episode 2" });
  assert.equal(C.hasCaptions(ep), false, "a fresh episode starts with no captions");
});
