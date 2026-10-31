/**
 * mp4.js — Motor «Zhezhi 2.0»: sello de contenedor MP4.
 *
 * No recodifica nada: reescribe el contenedor MP4 a nivel de átomos (boxes),
 * con la misma estructura que el archivo de referencia que la plataforma
 * respeta:
 *
 *   1. mvhd pasa a versión 1 y su `duration` se escribe como
 *      0xFFFFFFFFFFFFFFFF (duración desconocida).
 *   2. Se borran las udta del moov y de las pistas y se escribe una firma
 *      propia en udta/meta/ilst (©ART, ©nam, ©too, ©enc, ©wrt, ©cmt, cprt).
 *   3. Los handlers se renombran: vídeo → firma del taller, audio → SoundHandler.
 *   4. El «compressor name» del stsd de vídeo se sobrescribe con la firma.
 *   5. Si el moov ya va antes del mdat (faststart), se recalculan todos los
 *      offsets stco/co64 (con paso a co64 si hace falta) por el crecimiento
 *      del moov.
 *
 * El resultado es un MP4 válido pero con una firma de encoder ajena y una
 * duración declarada como desconocida.
 */

export class Mp4Error extends Error {
  constructor(message) {
    super(message);
    this.name = "Mp4Error";
  }
}

const CONTAINERS = new Set(["moov", "trak", "edts", "mdia", "minf", "stbl", "dinf"]);
const FRAGMENTED = new Set(["moof", "mfra", "styp", "sidx", "emsg", "prft"]);
// Códecs que el parcheo acepta sin tocar el flujo de vídeo.
const PATCHABLE_CODECS = new Set(["avc1", "avc3", "hvc1", "hev1", "dvh1", "dvhe"]);

const DEFAULTS = {
  sign: true,
  tagName: "BlueZhezhi-v2.0",
  tagComment: "BlueZhezhi",
  handlerName: "BlueZhezhi-coded",
  audioHandler: "SoundHandler",
  markUnknownDuration: true,
};

/* ------------------------------------------------------------------ */
/* utilidades de bytes                                                 */
/* ------------------------------------------------------------------ */

function toBytes(input) {
  if (input instanceof Uint8Array) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError("Se esperaba un ArrayBuffer o Uint8Array.");
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32(bytes, offset) {
  return viewOf(bytes).getUint32(offset, false);
}

function setU32(bytes, offset, value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Mp4Error(`El valor ${value} no cabe en un campo de 32 bits.`);
  }
  viewOf(bytes).setUint32(offset, value, false);
}

function ascii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function indexOfBytes(haystack, needle, from = 0) {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* parser / serializador                                               */
/* ------------------------------------------------------------------ */

function parseRange(bytes, start, end, depth = 0) {
  if (depth > 8) throw new Mp4Error("Anidamiento de cajas demasiado profundo.");
  const boxes = [];
  let at = start;

  while (at + 8 <= end) {
    let size = u32(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    let headerSize = 8;

    if (size === 1) {
      if (at + 16 > end) throw new Mp4Error(`Cabecera de 64 bits truncada en "${type}".`);
      const big = viewOf(bytes).getBigUint64(at + 8, false);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Mp4Error(`La caja "${type}" es demasiado grande.`);
      }
      size = Number(big);
      headerSize = 16;
    } else if (size === 0) {
      size = end - at;
    }

    if (size < headerSize || at + size > end) {
      throw new Mp4Error(`Caja "${type}" inválida en el byte ${at}.`);
    }

    const payloadStart = at + headerSize;
    const payloadEnd = at + size;
    const box = {
      type,
      start: at,
      size,
      headerSize,
      payloadStart,
      payloadEnd,
      payload: bytes.subarray(payloadStart, payloadEnd),
      children: null,
    };

    if (CONTAINERS.has(type)) {
      box.children = parseRange(bytes, payloadStart, payloadEnd, depth + 1);
    }

    boxes.push(box);
    at += size;
  }

  if (at !== end) {
    throw new Mp4Error(`Quedan ${end - at} bytes sin parsear: el MP4 no es convencional.`);
  }
  return boxes;
}

export function parseMp4(input) {
  const bytes = toBytes(input);
  const boxes = parseRange(bytes, 0, bytes.length);
  return { bytes, boxes };
}

function serializeBox(box) {
  const content = box.children ? concat(box.children.map(serializeBox)) : box.payload;
  const size = content.byteLength + 8;
  if (size > 0xffffffff) throw new Mp4Error(`La caja "${box.type}" supera los 4 GB.`);
  const out = new Uint8Array(size);
  setU32(out, 0, size);
  out.set(asciiBytes(box.type), 4);
  out.set(content, 8);
  return out;
}

function rawBox(type, payload) {
  return { type, payload, children: null, start: -1, size: payload.byteLength + 8 };
}

function boxBytes(type, payload) {
  return serializeBox(rawBox(type, payload));
}

function findChild(box, type) {
  return box.children ? box.children.find((child) => child.type === type) ?? null : null;
}

function findAll(box, type, out = []) {
  if (box.type === type) out.push(box);
  for (const child of box.children ?? []) findAll(child, type, out);
  return out;
}

function pathBox(box, ...types) {
  let current = box;
  for (const type of types) {
    if (!current) return null;
    current = findChild(current, type);
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* lectores de campos                                                  */
/* ------------------------------------------------------------------ */

function handlerType(trak) {
  const hdlr = pathBox(trak, "mdia", "hdlr");
  return hdlr && hdlr.payload.byteLength >= 12 ? ascii(hdlr.payload, 8, 4) : "";
}

function readOffsets(box) {
  const payload = box.payload;
  const count = u32(payload, 4);
  const stride = box.type === "co64" ? 8 : 4;
  if (8 + count * stride > payload.byteLength) {
    throw new Mp4Error(`Caja ${box.type} truncada.`);
  }
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const base = 8 + i * stride;
    if (stride === 8) {
      const big = viewOf(payload).getBigUint64(base, false);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Mp4Error("Offset de chunk fuera de rango seguro.");
      }
      out.push(Number(big));
    } else {
      out.push(u32(payload, base));
    }
  }
  return out;
}

function writeOffsets(box, values) {
  const use64 = box.type === "co64" || values.some((value) => value > 0xffffffff);
  const stride = use64 ? 8 : 4;
  const payload = new Uint8Array(8 + values.length * stride);
  payload.set(box.payload.subarray(0, 4));
  setU32(payload, 4, values.length);
  values.forEach((value, i) => {
    const base = 8 + i * stride;
    if (use64) viewOf(payload).setBigUint64(base, BigInt(value), false);
    else setU32(payload, base, value);
  });
  box.type = use64 ? "co64" : "stco";
  box.payload = payload;
}

function readStts(box) {
  const payload = box.payload;
  const count = u32(payload, 4);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    entries.push([u32(payload, 8 + 8 * i), u32(payload, 12 + 8 * i)]);
  }
  return entries;
}

function videoFps(trak) {
  const mdhd = pathBox(trak, "mdia", "mdhd");
  const stts = pathBox(trak, "mdia", "minf", "stbl", "stts");
  if (!mdhd || !stts) return 0;
  const timescale = u32(mdhd.payload, mdhd.payload[0] === 1 ? 20 : 12);
  let samples = 0;
  let ticks = 0;
  for (const [count, delta] of readStts(stts)) {
    samples += count;
    ticks += count * delta;
  }
  return ticks > 0 && timescale > 0 ? (samples * timescale) / ticks : 0;
}

function durationOf(mvhd) {
  const version = mvhd.payload[0];
  if (version === 1) {
    const big = viewOf(mvhd.payload).getBigUint64(24, false);
    return big === 0xffffffffffffffffn ? { unknown: true, seconds: NaN } : { unknown: false, seconds: Number(big) };
  }
  const raw = u32(mvhd.payload, 16);
  const timescale = u32(mvhd.payload, 12);
  if (raw === 0xffffffff) return { unknown: true, seconds: NaN };
  return { unknown: false, seconds: timescale ? raw / timescale : NaN };
}

/* ------------------------------------------------------------------ */
/* transformaciones                                                    */
/* ------------------------------------------------------------------ */

function dataBox(text) {
  const value = new TextEncoder().encode(text);
  const payload = new Uint8Array(8 + value.byteLength);
  setU32(payload, 0, 1); // version 0, flags 1 → texto UTF-8
  payload.set(value, 8); // bytes 4..8 = locale 0
  return boxBytes("data", payload);
}

function ilstItem(name, text) {
  return boxBytes(name, dataBox(text));
}

function makeUdta(items) {
  const ilst = concat(items.map(([name, text]) => ilstItem(name, text)));
  const hdlrPayload = concat([new Uint8Array(8), asciiBytes("mdirappl"), new Uint8Array(9)]);
  const meta = concat([new Uint8Array(4), boxBytes("hdlr", hdlrPayload), boxBytes("ilst", ilst)]);
  return rawBox("udta", boxBytes("meta", meta));
}

function setHandlerName(trak, name) {
  const hdlr = pathBox(trak, "mdia", "hdlr");
  if (!hdlr || hdlr.payload.byteLength < 24) return false;
  const encoded = new TextEncoder().encode(name).subarray(0, 63);
  hdlr.payload = concat([hdlr.payload.subarray(0, 24), encoded, new Uint8Array(1)]);
  return true;
}

function setCompressorName(trak, name) {
  const stsd = pathBox(trak, "mdia", "minf", "stbl", "stsd");
  if (!stsd || stsd.payload.byteLength < 16) return 0;

  const payload = stsd.payload.slice();
  const count = u32(payload, 4);
  const encoded = new TextEncoder().encode(name).subarray(0, 31);
  let at = 8;
  let patched = 0;

  for (let i = 0; i < count && at + 8 <= payload.byteLength; i += 1) {
    const size = u32(payload, at);
    if (size < 8 || at + size > payload.byteLength) break;
    const codec = ascii(payload, at + 4, 4);
    if (PATCHABLE_CODECS.has(codec) && size >= 82) {
      // VisualSampleEntry: compressorname = 32 bytes (largo + 31) en offset 50.
      payload.fill(0, at + 50, at + 82);
      payload[at + 50] = encoded.byteLength;
      payload.set(encoded, at + 51);
      patched += 1;
    }
    at += size;
  }

  stsd.payload = payload;
  return patched;
}

function markUnknownDuration(moov) {
  const mvhd = findChild(moov, "mvhd");
  if (!mvhd) throw new Mp4Error("El moov no tiene mvhd.");

  const payload = mvhd.payload;
  if (payload[0] === 1) {
    if (payload.byteLength < 112) throw new Mp4Error("mvhd versión 1 mal formado.");
    const next = payload.slice();
    next.fill(0xff, 24, 32); // duration = 0xFFFFFFFFFFFFFFFF
    mvhd.payload = next;
    return;
  }
  if (payload[0] !== 0) throw new Mp4Error(`Versión de mvhd no soportada: ${payload[0]}.`);
  if (payload.byteLength < 100) throw new Mp4Error("mvhd versión 0 mal formado.");

  // Reescribir el mvhd como versión 1 (112 bytes) con duración desconocida.
  const next = new Uint8Array(112);
  next[0] = 1;
  next.set(payload.subarray(1, 4), 1); // flags
  next.set(payload.subarray(4, 8), 8); // creation_time
  next.set(payload.subarray(8, 12), 16); // modification_time
  next.set(payload.subarray(12, 16), 20); // timescale
  next.fill(0xff, 24, 32); // duration desconocida
  next.set(payload.subarray(20, 100), 32); // rate, volume, matriz, pre_defined, next_track_ID
  mvhd.payload = next;
}

/* ------------------------------------------------------------------ */
/* inspección                                                          */
/* ------------------------------------------------------------------ */

export function inspectMp4(input) {
  const { bytes, boxes } = parseMp4(input);

  if (boxes.some((box) => FRAGMENTED.has(box.type))) {
    throw new Mp4Error("MP4 fragmentado (moof/sidx): hay que remuxear antes de parchear.");
  }

  const ftyp = boxes.find((box) => box.type === "ftyp") ?? null;
  const moov = boxes.find((box) => box.type === "moov") ?? null;
  const mdat = boxes.find((box) => box.type === "mdat") ?? null;
  if (!moov || !mdat) throw new Mp4Error("No se encontraron las cajas moov y mdat.");

  const tracks = (moov.children ?? []).filter((box) => box.type === "trak");
  const video = tracks.find((trak) => handlerType(trak) === "vide") ?? null;
  const audio = tracks.find((trak) => handlerType(trak) === "soun") ?? null;

  let width = 0;
  let height = 0;
  let codec = "";
  let fps = 0;
  let duration = { unknown: false, seconds: NaN };

  const mvhd = findChild(moov, "mvhd");
  if (mvhd) duration = durationOf(mvhd);

  if (video) {
    const tkhd = findChild(video, "tkhd");
    if (tkhd && tkhd.payload.byteLength >= 84) {
      const base = tkhd.payload[0] === 1 ? 88 : 76;
      width = u32(tkhd.payload, base) / 65536;
      height = u32(tkhd.payload, base + 4) / 65536;
    }
    const stsd = pathBox(video, "mdia", "minf", "stbl", "stsd");
    if (stsd && stsd.payload.byteLength >= 16) codec = ascii(stsd.payload, 12, 4);
    fps = videoFps(video);
  }

  return {
    bytes: bytes.byteLength,
    brands: ftyp ? ascii(ftyp.payload, 0, 4) : "",
    codec,
    width,
    height,
    fps,
    durationSec: duration.seconds,
    durationUnknown: duration.unknown,
    hasAudio: Boolean(audio),
    trackCount: tracks.length,
    faststart: boxes.indexOf(moov) < boxes.indexOf(mdat),
    fragmented: false,
  };
}

/* ------------------------------------------------------------------ */
/* parcheo                                                             */
/* ------------------------------------------------------------------ */

export function patchMp4(input, userOptions = {}) {
  const opts = { ...DEFAULTS, ...userOptions };
  const { bytes, boxes } = parseMp4(input);

  if (boxes.some((box) => FRAGMENTED.has(box.type))) {
    throw new Mp4Error("MP4 fragmentado: se necesita remuxear primero.");
  }

  const moov = boxes.find((box) => box.type === "moov");
  const mdats = boxes.filter((box) => box.type === "mdat");
  if (!moov || !moov.children || mdats.length !== 1) {
    throw new Mp4Error("Se requiere exactamente un moov y un mdat.");
  }
  const mdat = mdats[0];

  const tracks = moov.children.filter((box) => box.type === "trak");
  const video = tracks.find((trak) => handlerType(trak) === "vide");
  if (!video) throw new Mp4Error("No hay pista de vídeo.");
  const audio = tracks.find((trak) => handlerType(trak) === "soun") ?? null;

  const stsd = pathBox(video, "mdia", "minf", "stbl", "stsd");
  const codec = stsd && stsd.payload.byteLength >= 16 ? ascii(stsd.payload, 12, 4) : "";
  if (!PATCHABLE_CODECS.has(codec)) {
    throw new Mp4Error(
      `Códec "${codec || "desconocido"}": hay que convertir a H.264/HEVC antes de parchear.`,
    );
  }

  const fps = videoFps(video);
  if (fps > 120.5) {
    throw new Mp4Error(`Vídeo a ${fps.toFixed(1)} fps: por encima del límite de 120 fps.`);
  }

  const originalMoovBytes = moov.size;
  const report = {
    codec,
    fps,
    trackCount: tracks.length,
    hasAudio: Boolean(audio),
    signed: false,
    durationUnknown: false,
    faststart: boxes.indexOf(moov) < boxes.indexOf(mdat),
    offsetsShifted: 0,
    originalMoovBytes,
  };

  /* 1. firma en udta/meta/ilst + handlers + compressor name */
  if (opts.sign) {
    moov.children = moov.children.filter((box) => box.type !== "udta" && box.type !== "meta");
    for (const trak of tracks) {
      if (!trak.children) continue;
      trak.children = trak.children.filter((box) => box.type !== "udta");
    }

    moov.children.push(
      makeUdta([
        ["\u00a9ART", opts.tagComment],
        ["\u00a9nam", opts.tagComment],
        ["\u00a9too", opts.tagName],
        ["\u00a9enc", opts.tagName],
        ["\u00a9wrt", opts.tagComment],
        ["\u00a9cmt", opts.tagComment],
        ["cprt", opts.tagComment],
      ]),
    );

    video.children.push(
      makeUdta([
        ["\u00a9too", opts.tagName],
        ["\u00a9enc", opts.tagName],
      ]),
    );

    setHandlerName(video, opts.handlerName);
    if (audio) setHandlerName(audio, opts.audioHandler);
    report.compressorNamePatched = setCompressorName(video, opts.tagName);
    report.signed = true;
  }

  /* 2. duración desconocida */
  if (opts.markUnknownDuration) {
    markUnknownDuration(moov);
    report.durationUnknown = true;
  }

  /* 3. offsets: el moov ha cambiado de tamaño y el mdat se ha movido */
  const originalMoovEnd = moov.start + moov.size;
  const offsetBoxes = [...findAll(moov, "stco"), ...findAll(moov, "co64")];
  const originalOffsets = new Map(offsetBoxes.map((box) => [box, readOffsets(box)]));

  let moovBytes = serializeBox(moov);
  if (report.faststart) {
    let stable = false;
    for (let iteration = 0; iteration < 12 && !stable; iteration += 1) {
      const delta = moovBytes.byteLength - moov.size;
      for (const box of offsetBoxes) {
        const shifted = originalOffsets
          .get(box)
          .map((value) => (value >= originalMoovEnd ? value + delta : value));
        writeOffsets(box, shifted);
      }
      const next = serializeBox(moov);
      stable = next.byteLength === moovBytes.byteLength;
      moovBytes = next;
    }
    if (!stable) throw new Mp4Error("No se pudo estabilizar el tamaño de moov.");
  }

  report.offsetsShifted = offsetBoxes.reduce((sum, box) => sum + readOffsets(box).length, 0);
  report.outputMoovBytes = moovBytes.byteLength;

  /* 4. recomponer el archivo sin copiar el mdat dos veces */
  const parts = boxes.map((box) =>
    box === moov ? moovBytes : bytes.subarray(box.start, box.start + box.size),
  );
  const output = concat(parts);

  report.inputSize = bytes.byteLength;
  report.outputSize = output.byteLength;
  report.sizeDelta = output.byteLength - bytes.byteLength;
  report.tagName = opts.sign ? opts.tagName : null;
  report.handlerName = opts.sign ? opts.handlerName : null;
  report.audioHandler = opts.sign && audio ? opts.audioHandler : null;

  return { bytes: output, report };
}

/* ------------------------------------------------------------------ */
/* verificación                                                        */
/* ------------------------------------------------------------------ */

export function verifyMp4(input, options = {}) {
  const { bytes, boxes } = parseMp4(input);
  const issues = [];

  const moovIndex = boxes.findIndex((box) => box.type === "moov");
  const mdatIndex = boxes.findIndex((box) => box.type === "mdat");
  if (moovIndex < 0 || mdatIndex < 0) throw new Mp4Error("Faltan moov o mdat en la salida.");
  if (options.requireFaststart && moovIndex > mdatIndex) {
    issues.push("moov no está antes de mdat (sin faststart).");
  }

  const moov = boxes[moovIndex];
  const mdat = boxes[mdatIndex];
  const offsets = [...findAll(moov, "stco"), ...findAll(moov, "co64")];
  let chunks = 0;
  for (const box of offsets) {
    for (const value of readOffsets(box)) {
      chunks += 1;
      if (value < mdat.payloadStart || value > mdat.payloadEnd) {
        issues.push(`Chunk offset ${value} fuera del mdat.`);
        break;
      }
    }
  }

  const mvhd = findChild(moov, "mvhd");
  if (options.expectUnknownDuration) {
    if (!mvhd || !durationOf(mvhd).unknown) {
      issues.push("mvhd no declara la duración como desconocida.");
    }
  }

  if (options.tagName) {
    const needle = new TextEncoder().encode(options.tagName);
    const udta = [...findAll(moov, "udta")];
    const found = udta.some((box) => indexOfBytes(box.payload, needle) !== -1);
    if (!found) issues.push(`No se encontró la firma "${options.tagName}" en udta.`);
  }

  const info = inspectMp4(bytes);
  return { ok: issues.length === 0, issues, chunks, info };
}
