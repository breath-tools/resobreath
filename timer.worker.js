/* ResoBreathe timer worker
   Master clock for breathing session timing (prevents UI thread RAF throttling drift).
   Messages:
     cmd:start { inhaleSec, exhaleSec, plannedSec, ticks }
     cmd:pause
     cmd:resume
     cmd:stop
   Emits:
     {type:'phase', name:'INHALE'|'EXHALE', label:'Inhale'|'Exhale'}
     {type:'tick'}   // 2-1 countdown tick event
     {type:'progress', phase, phaseProgress01, elapsedTotalSec, remainingSec|null}
     {type:'complete'}
*/

let running = false;
let paused = false;

let inhaleSec = 4;
let exhaleSec = 6;
let plannedSec = 0;
let ticksEnabled = false;

let tStart = 0;
let pausedAt = 0;
let pauseAccum = 0;

let lastPhase = null;
let ticked2 = false;
let ticked1 = false;

let lastProgressSentAt = 0;
let intervalId = null;

function clamp(x, a, b) {
  if (!Number.isFinite(x)) return a;
  return Math.max(a, Math.min(b, x));
}

function nowMs() {
  return performance.now();
}

function resetTickState() {
  ticked2 = false;
  ticked1 = false;
}

function computePhaseAt(elapsedTotalSec) {
  const cycle = inhaleSec + exhaleSec;
  const t = ((elapsedTotalSec % cycle) + cycle) % cycle;
  if (t < inhaleSec) {
    return { name: "INHALE", label: "Inhale", phaseElapsed: t, phaseDur: inhaleSec };
  }
  return { name: "EXHALE", label: "Exhale", phaseElapsed: t - inhaleSec, phaseDur: exhaleSec };
}

function post(obj) {
  try { self.postMessage(obj); } catch (e) {}
}

function stopInternal() {
  running = false;
  paused = false;
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  lastPhase = null;
  resetTickState();
}

function loop() {
  if (!running) return;
  if (paused) return;

  const t = nowMs();
  const elapsedTotalSec = (t - tStart - pauseAccum) / 1000;

  // Completion
  if (plannedSec > 0 && elapsedTotalSec >= plannedSec) {
    post({ type: "progress", phase: lastPhase || "INHALE", phaseProgress01: 1, elapsedTotalSec, remainingSec: 0 });
    post({ type: "complete" });
    stopInternal();
    return;
  }

  const ph = computePhaseAt(elapsedTotalSec);

  // Phase change
  if (ph.name !== lastPhase) {
    lastPhase = ph.name;
    resetTickState();
    post({ type: "phase", name: ph.name, label: ph.label, phaseDurSec: ph.phaseDur });
  }

  // Ticks (2-1) in both phases
  if (ticksEnabled) {
    const remainingPhase = ph.phaseDur - ph.phaseElapsed;

    if (!ticked2 && remainingPhase <= 2.0 && remainingPhase > 1.05) {
      ticked2 = true;
      post({ type: "tick" });
    }
    if (!ticked1 && remainingPhase <= 1.0 && remainingPhase > 0.05) {
      ticked1 = true;
      post({ type: "tick" });
    }
  }

  // Progress (cap rate)
  const p01 = ph.phaseDur > 0 ? clamp(ph.phaseElapsed / ph.phaseDur, 0, 1) : 1;

  // Send progress at 2.5Hz (400ms throttle, 87% fewer messages than 80ms)
  if ((t - lastProgressSentAt) >= 400) {
    lastProgressSentAt = t;

    const remainingSec = plannedSec > 0 ? Math.max(0, plannedSec - elapsedTotalSec) : null;

    post({
      type: "progress",
      phase: ph.name,
      phaseProgress01: p01,
      elapsedTotalSec,
      remainingSec,
    });
  }
}

self.onmessage = (ev) => {
  const data = ev && ev.data ? ev.data : null;
  if (!data || typeof data !== "object") return;

  const cmd = String(data.cmd || "");

  if (cmd === "start") {
    stopInternal();

    inhaleSec = clamp(Number(data.inhaleSec || 4), 0.5, 60);
    exhaleSec = clamp(Number(data.exhaleSec || 6), 0.5, 60);
    plannedSec = Math.max(0, Number(data.plannedSec || 0));
    ticksEnabled = !!data.ticks;

    running = true;
    paused = false;

    tStart = nowMs();
    pausedAt = 0;
    pauseAccum = 0;

    lastPhase = null;
    resetTickState();
    lastProgressSentAt = 0;

    // Kick initial phase immediately
    const ph0 = computePhaseAt(0);
    lastPhase = ph0.name;
    post({ type: "phase", name: ph0.name, label: ph0.label, phaseDurSec: ph0.phaseDur });

    // 200ms interval (adaptive timing, less CPU usage)
    intervalId = setInterval(loop, 200);
    return;
  }

  if (cmd === "pause") {
    if (!running || paused) return;
    paused = true;
    pausedAt = nowMs();
    return;
  }

  if (cmd === "resume") {
    if (!running || !paused) return;
    const t = nowMs();
    pauseAccum += (t - pausedAt);
    paused = false;
    pausedAt = 0;
    return;
  }

  if (cmd === "stop") {
    stopInternal();
    return;
  }
};
