import { inspectMp4, patchMp4, verifyMp4, Mp4Error } from "./mp4.js";
import { convertToMp4 } from "./ffmpeg.js";

const CONFIG = {
  suffix: "zhezhi",
  runLabel: "Sellar el vídeo",
  busyLabel: "Sellando…",
};

const $ = (id) => document.getElementById(id);

const els = {
  drop: $("drop"),
  file: $("file"),
  fileInfo: $("fileInfo"),
  fName: $("fName"),
  fSize: $("fSize"),
  fDur: $("fDur"),
  fKind: $("fKind"),
  clear: $("clear"),
  tagName: $("tagName"),
  sign: $("sign"),
  unknown: $("unknown"),
  signNote: $("signNote"),
  unknownNote: $("unknownNote"),
  run: $("run"),
  error: $("error"),
  progress: $("progress"),
  stage: $("stage"),
  pct: $("pct"),
  bar: $("barFill"),
  stages: $("stages"),
  result: $("result"),
  rTitle: $("rTitle"),
  rMeta: $("rMeta"),
  report: $("report"),
  changes: $("changes"),
  download: $("download"),
};

const STAGES = [
  "Leyendo el archivo",
  "Analizando el contenedor",
  "Sellando el contenedor",
  "Convirtiendo el vídeo",
  "Verificando el sello",
];

let state = { file: null, duration: 0, busy: false, url: null };
let stageIndex = -1;

/* ------------------------------------------------------------------ */
/* formato                                                             */
/* ------------------------------------------------------------------ */

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1e3))} KB`;
}

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m} min ${s.toFixed(1)} s` : `${s.toFixed(1)} s`;
}

function fmtDelta(delta) {
  if (!delta) return "0";
  const sign = delta > 0 ? "+" : "−";
  if (Math.abs(delta) < 1000) return `${sign}${Math.abs(delta)} B`;
  return `${sign}${fmtBytes(Math.abs(delta))}`;
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function setError(message) {
  els.error.hidden = !message;
  els.error.textContent = message ?? "";
}

function setBusy(busy) {
  state.busy = busy;
  els.run.disabled = busy || !state.file;
  els.run.textContent = busy ? CONFIG.busyLabel : CONFIG.runLabel;
  els.drop.style.pointerEvents = busy ? "none" : "";
  if (!busy) els.progress.hidden = true;
}

function buildStages() {
  els.stages.innerHTML = "";
  for (const label of STAGES) {
    const li = document.createElement("li");
    li.textContent = label;
    els.stages.append(li);
  }
}

function setStage(name, ratio = 0) {
  const index = Math.max(0, STAGES.indexOf(name));
  if (index !== stageIndex) {
    stageIndex = index;
    els.stage.textContent = name;
    [...els.stages.children].forEach((li, i) => {
      li.classList.toggle("is-done", i < index);
      li.classList.toggle("is-active", i === index);
    });
  }
  const pct = Math.round(Math.min(1, Math.max(0, ratio)) * 100);
  els.pct.textContent = `${pct}%`;
  els.bar.style.width = `${pct}%`;
}

function showFile(file) {
  state.file = file;
  state.duration = 0;
  els.fileInfo.hidden = false;
  els.fName.textContent = file.name;
  els.fSize.textContent = fmtBytes(file.size);
  els.fDur.textContent = "leyendo…";
  const ext = /\.[a-z0-9]+$/i.exec(file.name);
  els.fKind.textContent = ext ? ext[0].slice(1).toUpperCase() : "desconocido";
  els.run.disabled = false;
  setError(null);
  els.result.hidden = true;

  const probe = document.createElement("video");
  probe.preload = "metadata";
  probe.onloadedmetadata = () => {
    state.duration = probe.duration || 0;
    els.fDur.textContent = fmtDuration(state.duration);
    URL.revokeObjectURL(probe.src);
  };
  probe.onerror = () => {
    els.fDur.textContent = "—";
    URL.revokeObjectURL(probe.src);
  };
  probe.src = URL.createObjectURL(file);

  if (file.size > 300 * 1024 * 1024) {
    setError(
      "Archivo grande: el procesado en navegador puede quedarse sin memoria. " +
        "Si falla, remuxea antes con ffmpeg de escritorio (ver README).",
    );
  }
}

function clearFile() {
  state.file = null;
  state.duration = 0;
  els.file.value = "";
  els.fileInfo.hidden = true;
  els.run.disabled = true;
  els.result.hidden = true;
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = null;
}

function updateOptions() {
  els.tagName.disabled = !els.sign.checked;
  els.signNote.hidden = !els.sign.checked;
  els.unknownNote.hidden = !els.unknown.checked;
}

function readOptions() {
  const tagName = (els.tagName.value || "BlueZhezhi-v2.0").trim().slice(0, 31) || "BlueZhezhi-v2.0";
  return {
    sign: els.sign.checked,
    tagName,
    tagComment: tagName,
    handlerName: tagName,
    audioHandler: "SoundHandler",
    markUnknownDuration: els.unknown.checked,
  };
}

/* ------------------------------------------------------------------ */
/* procesado                                                           */
/* ------------------------------------------------------------------ */

async function processFile() {
  if (!state.file || state.busy) return;

  const file = state.file;
  const options = readOptions();

  setError(null);
  els.result.hidden = true;
  els.progress.hidden = false;
  stageIndex = -1;
  buildStages();
  setBusy(true);
  setStage("Leyendo el archivo", 0.05);

  try {
    const buffer = new Uint8Array(await file.arrayBuffer());

    setStage("Analizando el contenedor", 0.15);
    let converted = null;
    let patched;

    try {
      patched = patchMp4(buffer, options);
    } catch (error) {
      const recoverable =
        error instanceof Mp4Error || error instanceof TypeError || error instanceof RangeError;
      if (!recoverable) throw error;

      setStage("Convirtiendo el vídeo", 0.2);
      converted = await convertToMp4(file, {
        onStatus: (text) => {
          els.stage.textContent = text;
        },
        onProgress: (ratio) => setStage("Convirtiendo el vídeo", 0.2 + ratio * 0.55),
      });

      setStage("Sellando el contenedor", 0.8);
      patched = patchMp4(converted.bytes, options);
    }

    setStage("Verificando el sello", 0.92);
    const verification = verifyMp4(patched.bytes, {
      tagName: options.sign ? options.tagName : null,
      expectUnknownDuration: options.markUnknownDuration,
    });

    setStage("Verificando el sello", 1);
    showResult(patched, verification, converted, options);
  } catch (error) {
    console.error(error);
    setError(error?.message ?? String(error));
    els.progress.hidden = true;
  } finally {
    setBusy(false);
  }
}

function showResult({ bytes, report }, verification, converted, options) {
  if (state.url) URL.revokeObjectURL(state.url);
  state.url = URL.createObjectURL(new Blob([bytes], { type: "video/mp4" }));

  const baseName = (state.file?.name ?? "video").replace(/\.[^.]+$/, "") || "video";
  els.download.href = state.url;
  els.download.download = `${baseName}_${CONFIG.suffix}.mp4`;

  const info = verification.info;
  const method =
    converted === null
      ? "parcheo directo (sin recodificar)"
      : `FFmpeg · ${converted.method === "remux" ? "remux" : "recodificado H.264"}`;

  els.rMeta.textContent = `${fmtBytes(bytes.byteLength)} · ${method}`;

  const rows = [
    ["Método", method],
    ["Entrada", fmtBytes(report.inputSize)],
    ["Salida", fmtBytes(report.outputSize)],
    ["Diferencia", fmtDelta(report.sizeDelta)],
    ["Códec", info.codec || "—"],
    [
      "Resolución",
      info.width && info.height
        ? `${Math.round(info.width)}×${Math.round(info.height)}`
        : "—",
    ],
    ["FPS", info.fps ? info.fps.toFixed(2) : "—"],
    ["Duración", info.durationUnknown ? "desconocida (mvhd)" : fmtDuration(info.durationSec)],
    ["moov", `${report.originalMoovBytes} → ${report.outputMoovBytes} B`],
    ["Offsets reescritos", String(report.offsetsShifted)],
    ["Chunks verificados", String(verification.chunks)],
  ];

  els.report.innerHTML = "";
  for (const [label, value] of rows) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    div.append(dt, dd);
    els.report.append(div);
  }

  const changes = [];
  if (report.durationUnknown) {
    changes.push(
      "mvhd reescrito a versión 1 con duration = 0xFFFFFFFFFFFFFFFF (desconocida).",
    );
  }
  if (report.signed) {
    changes.push(
      `Firma "${options.tagName}" escrita en udta/meta/ilst (©ART, ©nam, ©too, ©enc, ©wrt, ©cmt, cprt).`,
    );
    changes.push(
      `Handler de vídeo renombrado a "${options.handlerName}"` +
        (report.audioHandler ? `; el de audio a "${report.audioHandler}".` : "."),
    );
    if (report.compressorNamePatched) {
      changes.push(
        `Compressor name del stsd de vídeo sobrescrito con "${options.tagName}".`,
      );
    }
    changes.push("udta antiguas eliminadas del moov y de las pistas.");
  }
  if (report.faststart) {
    changes.push(
      `moov antes que mdat: ${report.offsetsShifted} offsets stco/co64 recalculados por el crecimiento del moov.`,
    );
  } else {
    changes.push("moov después de mdat: no hace falta tocar offsets (el archivo no es faststart).");
  }
  if (converted === null) {
    changes.push("El flujo de vídeo va copiado byte a byte: no se ha recodificado nada.");
  } else {
    changes.push(
      `El contenedor no era parcheable; se convirtió antes con FFmpeg.wasm (${converted.method}).`,
    );
  }

  els.changes.innerHTML = "";
  for (const text of changes) {
    const li = document.createElement("li");
    li.textContent = text;
    els.changes.append(li);
  }

  if (!verification.ok) {
    setError(`Aviso de verificación: ${verification.issues.join(" ")}`);
  }

  els.result.hidden = false;
  els.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ------------------------------------------------------------------ */
/* eventos                                                             */
/* ------------------------------------------------------------------ */

els.drop.addEventListener("click", () => els.file.click());
els.drop.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    els.file.click();
  }
});

els.file.addEventListener("change", () => {
  const file = els.file.files?.[0];
  if (file) showFile(file);
});

for (const type of ["dragenter", "dragover"]) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault();
    els.drop.classList.add("is-over");
  });
}
for (const type of ["dragleave", "drop"]) {
  els.drop.addEventListener(type, (event) => {
    event.preventDefault();
    els.drop.classList.remove("is-over");
  });
}
els.drop.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) showFile(file);
});

els.clear.addEventListener("click", clearFile);
els.sign.addEventListener("change", updateOptions);
els.unknown.addEventListener("change", updateOptions);
els.run.addEventListener("click", processFile);

updateOptions();
