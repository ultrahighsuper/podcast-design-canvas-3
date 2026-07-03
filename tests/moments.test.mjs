// tests/moments.test.mjs — timed visual moments model: validation, time
// parsing, [start, end) activation semantics, and persistence across preset
// and template switches.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPDC } from "./_load.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDC = loadPDC(root);
const M = PDC.moments;
const E = PDC.episode;

test("parseTime accepts seconds and M:SS forms", () => {
  assert.equal(M.parseTime("4"), 4);
  assert.equal(M.parseTime("2.5"), 2.5);
  assert.equal(M.parseTime(7), 7);
  assert.equal(M.parseTime("0:03"), 3);
  assert.equal(M.parseTime("0:00"), 0);
  assert.equal(M.parseTime("1:05"), 65);
  assert.equal(M.parseTime("2:30.5"), 150.5);
});

test("parseTime rejects non-times", () => {
  for (const bad of ["", "  ", "abc", "1:xx", "-3", "1:70", "0:3:4", null, undefined, NaN, -1, Infinity]) {
    assert.ok(Number.isNaN(M.parseTime(bad)), `expected NaN for ${String(bad)}`);
  }
});

test("updateMoment edits a title/callout moment's text in place", () => {
  const ep = E.createEpisode({});
  const title = M.addMoment(ep, { type: "title", text: "Old title", start: 1, end: 3 });
  const callout = M.addMoment(ep, { type: "callout", text: "Old callout", start: 4, end: 6 });
  const updated = M.updateMoment(ep, title.id, { text: "  New title  " });
  assert.equal(updated.text, "New title", "text is trimmed and replaced");
  assert.equal(updated.id, title.id, "same moment object is edited in place");
  assert.equal(M.listMoments(ep).find((m) => m.id === title.id).text, "New title");
  assert.equal(M.listMoments(ep).find((m) => m.id === callout.id).text, "Old callout", "other moments untouched");
  // The edited text renders at the moment's scheduled time.
  assert.deepEqual(M.activeMoments(ep, 2).map((m) => m.text), ["New title"]);
});

test("updateMoment can retime a moment and re-validates the window", () => {
  const ep = E.createEpisode({});
  const m = M.addMoment(ep, { type: "callout", text: "Ref", start: 4, end: 6 });
  assert.ok(M.updateMoment(ep, m.id, { start: "0:02", end: "0:05" }), "valid retime succeeds");
  assert.deepEqual([m.start, m.end], [2, 5]);
  assert.equal(M.updateMoment(ep, m.id, { end: 2 }), null, "end <= start is rejected");
  assert.equal(M.updateMoment(ep, m.id, { start: "nope" }), null, "unparseable time is rejected");
  assert.deepEqual([m.start, m.end], [2, 5], "a rejected edit leaves the moment unchanged");
});

test("updateMoment rejects empty text and unknown ids", () => {
  const ep = E.createEpisode({});
  const m = M.addMoment(ep, { type: "title", text: "Keep", start: 0, end: 2 });
  assert.equal(M.updateMoment(ep, m.id, { text: "   " }), null, "a text moment cannot be emptied");
  assert.equal(m.text, "Keep");
  assert.equal(M.updateMoment(ep, "moment-does-not-exist", { text: "x" }), null);
});

test("formatTime renders M:SS", () => {
  assert.equal(M.formatTime(0), "0:00");
  assert.equal(M.formatTime(3), "0:03");
  assert.equal(M.formatTime(65), "1:05");
  assert.equal(M.formatTime(3.9), "0:03");
});

test("validateMoment requires a type, content, and 0 <= start < end", () => {
  assert.equal(M.validateMoment({ type: "title", text: "EP", start: "0:00", end: "0:03" }), "");
  assert.equal(M.validateMoment({ type: "callout", text: "Ref", start: 4, end: 7 }), "");
  assert.equal(M.validateMoment({ type: "image", imageName: "clip.png", start: 2, end: 5 }), "");
  assert.match(M.validateMoment({ type: "banner", text: "x", start: 0, end: 1 }), /type/i);
  assert.match(M.validateMoment({ type: "title", text: "   ", start: 0, end: 1 }), /text/i);
  assert.match(M.validateMoment({ type: "image", start: 0, end: 1 }), /PNG image/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: "nope", end: 1 }), /start/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 0, end: "nope" }), /end/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 3, end: 3 }), /after/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 5, end: 2 }), /after/i);
});

test("addMoment stores valid moments on the episode and rejects invalid ones", () => {
  const ep = E.createEpisode({});
  const title = M.addMoment(ep, { type: "title", text: "  EP TITLE  ", start: "0:00", end: "0:03" });
  assert.ok(title && title.id, "valid moment should be added with an id");
  assert.equal(title.text, "EP TITLE", "text should be trimmed");
  assert.equal(title.start, 0);
  assert.equal(title.end, 3);
  assert.equal(M.addMoment(ep, { type: "title", text: "", start: 0, end: 3 }), null);
  assert.equal(M.addMoment(ep, { type: "callout", text: "x", start: 7, end: 4 }), null);
  assert.equal(M.listMoments(ep).length, 1, "invalid moments must not be stored");
});

test("image moments store only PNG metadata, not image bytes", () => {
  const ep = E.createEpisode({});
  const image = M.addMoment(ep, { type: "image", imageName: "overlay.png", start: 2, end: 5 });
  assert.ok(image && image.id);
  assert.equal(image.type, "image");
  assert.equal(image.imageName, "overlay.png");
  assert.equal(image.text, "");
  assert.equal(JSON.stringify(image).includes("data:image"), false);
});

test("listMoments returns moments ordered by start time", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "callout", text: "later", start: 4, end: 7 });
  M.addMoment(ep, { type: "title", text: "first", start: 0, end: 3 });
  assert.deepEqual(M.listMoments(ep).map((m) => m.text), ["first", "later"]);
});

test("removeMoment removes exactly the identified moment", () => {
  const ep = E.createEpisode({});
  const a = M.addMoment(ep, { type: "title", text: "A", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "B", start: 4, end: 7 });
  assert.equal(M.removeMoment(ep, a.id), true);
  assert.equal(M.removeMoment(ep, a.id), false, "removing twice reports failure");
  assert.deepEqual(M.listMoments(ep).map((m) => m.text), ["B"]);
});

test("activeMoments is start-inclusive and end-exclusive", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "EP TITLE", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "CALLOUT REF", start: 4, end: 7 });
  M.addMoment(ep, { type: "image", imageName: "overlay.png", start: 8, end: 10 });
  const texts = (t) => M.activeMoments(ep, t).map((m) => m.text);
  const types = (t) => M.activeMoments(ep, t).map((m) => m.type);
  assert.deepEqual(texts(0), ["EP TITLE"], "start boundary is inclusive");
  assert.deepEqual(texts(1.5), ["EP TITLE"]);
  assert.deepEqual(texts(2.999), ["EP TITLE"]);
  assert.deepEqual(texts(3), [], "end boundary is exclusive");
  assert.deepEqual(texts(3.5), [], "gap between moments shows nothing");
  assert.deepEqual(texts(4), ["CALLOUT REF"], "callout starts exactly at 4");
  assert.deepEqual(texts(5), ["CALLOUT REF"]);
  assert.deepEqual(texts(7), [], "callout gone at its end time");
  assert.deepEqual(types(8), ["image"], "image moment starts exactly at 8");
  assert.deepEqual(types(10), [], "image moment is gone at its end");
  assert.deepEqual(texts(-1), []);
  assert.deepEqual(texts(NaN), []);
});

test("overlapping moments are both active inside the overlap", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "T", start: 0, end: 5 });
  M.addMoment(ep, { type: "callout", text: "C", start: 3, end: 8 });
  assert.deepEqual(M.activeMoments(ep, 4).map((m) => m.text), ["T", "C"]);
  assert.deepEqual(M.activeMoments(ep, 2).map((m) => m.text), ["T"]);
  assert.deepEqual(M.activeMoments(ep, 6).map((m) => m.text), ["C"]);
});

test("validateMoment accepts start + duration instead of end", () => {
  assert.equal(M.validateMoment({ type: "title", text: "EP", start: 1, duration: 2 }), "");
  assert.equal(M.validateMoment({ type: "callout", text: "Ref", start: 4, duration: 2 }), "");
  assert.match(M.validateMoment({ type: "title", text: "x", start: 1 }), /duration|end/i);
  assert.match(M.validateMoment({ type: "title", text: "x", start: 1, duration: 0 }), /after|duration/i);
});

test("addMoment stores end computed from start + duration", () => {
  const ep = E.createEpisode({});
  const title = M.addMoment(ep, { type: "title", text: "SEGMENT OPENER", start: 1, duration: 2 });
  assert.equal(title.start, 1);
  assert.equal(title.end, 3);
  const callout = M.addMoment(ep, { type: "callout", text: "KEY QUOTE", start: 4, duration: 2 });
  assert.equal(callout.start, 4);
  assert.equal(callout.end, 6);
  assert.deepEqual(M.activeMoments(ep, 2).map((m) => m.type), ["title"]);
  assert.deepEqual(M.activeMoments(ep, 5).map((m) => m.type), ["callout"]);
  assert.deepEqual(M.activeMoments(ep, 7), []);
});

test("title and callout moments survive preset switches alongside captions", () => {
  const ep = E.createEpisode({});
  M.addMoment(ep, { type: "title", text: "EP TITLE", start: 0, end: 3 });
  M.addMoment(ep, { type: "callout", text: "CALLOUT REF", start: 4, end: 7 });
  const before = JSON.stringify(M.listMoments(ep));
  for (const preset of ["stack", "spotlight", "split"]) {
    E.setPreset(ep, preset);
    assert.equal(ep.presetId, preset);
    assert.equal(JSON.stringify(M.listMoments(ep)), before, `moments unchanged on ${preset}`);
    assert.deepEqual(M.activeMoments(ep, 1.5).map((m) => m.text), ["EP TITLE"]);
    assert.deepEqual(M.activeMoments(ep, 5).map((m) => m.text), ["CALLOUT REF"]);
  }
  const tpl = PDC.templates.saveTemplate("Custom", { host: { x: 0, y: 0, w: 50, h: 100 } });
  E.setPreset(ep, tpl.id);
  assert.equal(ep.presetId, tpl.id);
  assert.equal(JSON.stringify(M.listMoments(ep)), before, "moments unchanged on a custom template");
});

test("episodes created before the moments feature still work (lazy list)", () => {
  const ep = E.createEpisode({});
  delete ep.moments; // simulate a pre-feature episode object
  assert.deepEqual(M.listMoments(ep), []);
  assert.deepEqual(M.activeMoments(ep, 1), []);
  assert.ok(M.addMoment(ep, { type: "title", text: "x", start: 0, end: 1 }));
  assert.equal(M.listMoments(ep).length, 1);
});
