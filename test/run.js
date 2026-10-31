/**
 * run.js — prueba del motor «Zhezhi 2.0» con un MP4 sintético.
 *
 * No hay vídeo real: se construye un contenedor mínimo pero correcto
 * (ftyp + moov con una pista de vídeo avc1 + mdat) para comprobar que el
 * parcheo reescribe lo que debe y que los offsets siguen cuadrando.
 */

import { inspectMp4, patchMp4, verifyMp4, Mp4Error } from "../src/mp4.js";

const SAMPLE_COUNT = 100;
const SAMPLE_SIZE = 8;
const TIMESCALE = 1000;
const DELTA = 40; // 25 fps

/* ------------------------------------------------------------------ */
/* constructor de bytes                                                */
/* ------------------------------------------------------------------ */

function ascii(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function zeros(n) {
  return new Uint8Array(n);
}

function u16(...values) {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint16(i * 2, value, false));
  return out;
}

function u32(...values) {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  values.forEach((value, i) => view.setUint32(i * 4, value, false));
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type, ...parts) {
  const payload = concat(parts);
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length, false);
  out.set(ascii(type), 4);
  out.set(payload, 8);
  return out;
}

const MATRIX = u32(
  0x00010000, 0, 0,
  0, 0x00010000, 0,
  0, 0, 0x40000000,
);

function compressorName(text) {
  const out = new Uint8Array(32);
  const bytes = ascii(text).subarray(0, 31);
  out[0] = bytes.length;
  out.set(bytes, 1);
  return out;
}

/* ------------------------------------------------------------------ */
/* MP4 sintético                                                       */
/* ------------------------------------------------------------------ */

function ftyp() {
  return box("ftyp", ascii("isom"), u32(512), ascii("isomiso2avc1mp41"));
}

function makeMoov({ offsets, codec = "avc1", delta = DELTA }) {
  const mvhd = box(
    "mvhd",
    u32(0), u32(0), u32(0), u32(TIMESCALE), u32(SAMPLE_COUNT * delta),
    u32(0x00010000), u16(0x0100), u16(0),
    zeros(8), MATRIX, zeros(24), u32(2),
  );

  const tkhd = box(
    "tkhd",
    u32(7), u32(0), u32(0), u32(1), u32(0), u32(SAMPLE_COUNT * delta),
    zeros(8), u16(0), u16(0), u16(0), u16(0),
    MATRIX, u32(1080 << 16), u32(1920 << 16),
  );

  const mdhd = box(
    "mdhd",
    u32(0), u32(0), u32(0), u32(TIMESCALE), u32(SAMPLE_COUNT * delta),
    u16(0x55c4), u16(0),
  );

  const hdlr = box("hdlr", u32(0), u32(0), ascii("vide"), zeros(12), ascii("VideoHandler\0"));
  const vmhd = box("vmhd", u32(1), u16(0), u16(0), u16(0), u16(0));
  const dref = box("dref", u32(0), u32(1), box("url ", u32(1)));
  const dinf = box("dinf", dref);

  const sampleEntry = box(
    codec,
    zeros(6), u16(1), // reserved + data_reference_index
    u16(0), u16(0), zeros(12), // pre_defined, reserved, pre_defined[3]
    u16(1080), u16(1920), // width, height
    u32(0x00480000), u32(0x00480000), // resolutions
    u32(0), u16(1), // reserved, frame_count
    compressorName("TestEncoder"), // 32 bytes en el offset 50 de la entrada
    u16(24), u16(0xffff), // depth, pre_defined
  );

  const stsd = box("stsd", u32(0), u32(1), sampleEntry);
  const stts = box("stts", u32(0), u32(1), u32(SAMPLE_COUNT), u32(delta));
  const stsc = box("stsc", u32(0), u32(1), u32(1), u32(1), u32(1));
  const stsz = box(
    "stsz",
    u32(0),
    u32(0),
    u32(SAMPLE_COUNT),
    u32(...new Array(SAMPLE_COUNT).fill(SAMPLE_SIZE)),
  );
  const stco = box("stco", u32(0), u32(SAMPLE_COUNT), u32(...offsets));

  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const minf = box("minf", vmhd, dinf, stbl);
  const mdia = box("mdia", mdhd, hdlr, minf);
  const trak = box("trak", tkhd, mdia);
  const udta = box("udta", box("\u00a9too", box("data", u32(1), u32(0), ascii("OldTool"))));

  return box("moov", mvhd, trak, udta);
}

function build({ faststart = true, codec = "avc1", delta = DELTA } = {}) {
  const ftypBytes = ftyp();
  const mdatBytes = box("mdat", zeros(SAMPLE_COUNT * SAMPLE_SIZE));

  const placeholder = new Array(SAMPLE_COUNT).fill(0);
  let moovBytes = makeMoov({ offsets: placeholder, codec, delta });

  const base = faststart
    ? ftypBytes.length + moovBytes.length + 8
    : ftypBytes.length + 8;
  const offsets = Array.from({ length: SAMPLE_COUNT }, (_, i) => base + i * SAMPLE_SIZE);
  moovBytes = makeMoov({ offsets, codec, delta });

  return faststart
    ? concat([ftypBytes, moovBytes, mdatBytes])
    : concat([ftypBytes, mdatBytes, moovBytes]);
}

/* ------------------------------------------------------------------ */
/* pruebas                                                             */
/* ------------------------------------------------------------------ */

const results = [];

function test(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "ok" });
  } catch (error) {
    results.push({ name, ok: false, detail: error?.message ?? String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

test("inspección del MP4 sintético", () => {
  const info = inspectMp4(build());
  assert(info.codec === "avc1", `códec ${info.codec}`);
  assert(Math.round(info.fps) === 25, `fps ${info.fps}`);
  assert(Math.abs(info.durationSec - 4) < 0.01, `duración ${info.durationSec}`);
  assert(info.faststart === true, "no detecta faststart");
  assert(info.width === 1080 && info.height === 1920, `${info.width}×${info.height}`);
  return `${info.codec} · ${Math.round(info.fps)} fps · ${info.durationSec}s`;
});

test("sello por defecto: mvhd desconocido + firma + offsets", () => {
  const input = build();
  const { bytes, report } = patchMp4(input);
  const check = verifyMp4(bytes, { tagName: "BlueZhezhi-v2.0", expectUnknownDuration: true });

  assert(report.signed, "no firmó");
  assert(report.durationUnknown, "no marcó duración desconocida");
  assert(report.compressorNamePatched === 1, `compressor patched=${report.compressorNamePatched}`);
  assert(report.offsetsShifted === SAMPLE_COUNT, `offsets=${report.offsetsShifted}`);
  assert(report.sizeDelta > 0, "no creció");
  assert(check.ok, `verificación: ${check.issues.join(" ")}`);
  assert(check.info.durationUnknown === true, "la salida no declara duración desconocida");
  assert(check.info.faststart === true, "la salida perdió faststart");
  return `+${report.sizeDelta} B · moov ${report.originalMoovBytes}→${report.outputMoovBytes} · ${check.chunks} chunks`;
});

test("sin firma ni duración: la salida es idéntica a la entrada", () => {
  const input = build();
  const { bytes, report } = patchMp4(input, { sign: false, markUnknownDuration: false });
  assert(report.sizeDelta === 0, `delta ${report.sizeDelta}`);
  assert(equal(bytes, input), "los bytes cambiaron");
  return "0 B de diferencia";
});

test("moov después de mdat: no toca offsets", () => {
  const input = build({ faststart: false });
  const { bytes, report } = patchMp4(input);
  const check = verifyMp4(bytes, { tagName: "BlueZhezhi-v2.0", expectUnknownDuration: true });
  assert(report.faststart === false, "detectó faststart donde no lo hay");
  assert(check.ok, `verificación: ${check.issues.join(" ")}`);
  return `+${report.sizeDelta} B · ${check.chunks} chunks`;
});

test("idempotencia: sellar dos veces no vuelve a crecer", () => {
  const once = patchMp4(build()).bytes;
  const twice = patchMp4(once).bytes;
  const check = verifyMp4(twice, { tagName: "BlueZhezhi-v2.0", expectUnknownDuration: true });
  assert(check.ok, `verificación: ${check.issues.join(" ")}`);
  assert(once.length === twice.length, `${once.length} vs ${twice.length}`);
  return `${once.length} B estables`;
});

test("códec no parcheable (av01) → error", () => {
  let message = "";
  try {
    patchMp4(build({ codec: "av01" }));
  } catch (error) {
    assert(error instanceof Mp4Error, `error inesperado: ${error?.name}`);
    message = error.message;
  }
  assert(message.includes("av01"), "no menciona el códec");
  return message;
});

test("más de 120 fps → error", () => {
  let message = "";
  try {
    patchMp4(build({ delta: 5 }));
  } catch (error) {
    assert(error instanceof Mp4Error, `error inesperado: ${error?.name}`);
    message = error.message;
  }
  assert(message.includes("120"), "no menciona el límite");
  return message;
});

/* ------------------------------------------------------------------ */
/* pintar                                                              */
/* ------------------------------------------------------------------ */

window.__RESULTS__ = results;
// Para la prueba de interfaz: deja el constructor del MP4 sintético a mano.
window.__BUILD__ = build;

const out = document.getElementById("out");

if (out) {
  const passed = results.filter((r) => r.ok).length;
  out.innerHTML = "";

  const summary = document.createElement("h2");
  summary.innerHTML = `<span class="${passed === results.length ? "ok" : "bad"}">${passed}/${results.length}</span> pruebas correctas`;
  out.append(summary);

  const table = document.createElement("table");
  const head = document.createElement("tr");
  head.innerHTML = "<th>Prueba</th><th>Resultado</th><th>Detalle</th>";
  table.append(head);

  for (const result of results) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    name.textContent = result.name;
    const state = document.createElement("td");
    state.className = result.ok ? "ok" : "bad";
    state.textContent = result.ok ? "ok" : "falla";
    const detail = document.createElement("td");
    detail.innerHTML = `<code>${String(result.detail).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</code>`;
    row.append(name, state, detail);
    table.append(row);
  }
  out.append(table);
}
