"use strict";
/**
 * Shared press-to-speak capture for the demo and record pages: hold the mic
 * button (or Ctrl+M) to stream PCM16 @16kHz over /stt/realtime (WS proxy to
 * NeMo-Speech.cpp); partials stream to onPartial while held, release commits
 * and resolves onFinal with the transcript. The button stays hidden unless
 * /stt/health answers.
 * ponytail: ScriptProcessorNode is deprecated but keeps this dependency-free;
 * upgrade path is an AudioWorklet module.
 */
function createMic({ button, onPartial, onFinal, onError, canStart, onStart, onPress, onRelease, onCancel, holdKey }) {
  const IDLE_TITLE = holdKey === "Space" ? "Hold to speak (Space)" : "Hold to speak (Ctrl+M)";
  let ctx = null, stream = null, ws = null, pcmBytes = 0, final = null;
  let resolve = null, reject = null;
  let state = "idle", releaseWhileStarting = false;

  fetch("/stt/health").then((r) => { if (r.ok) button.hidden = false; }).catch(() => {});

  function setMic(s, title) {
    state = s;
    // "starting" paints the press state immediately, before getUserMedia and
    // the WebSocket handshake resolve.
    button.classList.toggle("recording", s === "starting" || s === "recording");
    button.disabled = s === "transcribing";
    button.title = title;
  }

  async function start() {
    if (canStart && !canStart()) return false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext({ sampleRate: 16000 }); // browser resamples the mic stream for us
      pcmBytes = 0;
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/stt/realtime`);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onclose = ws.onerror = () => rej(new Error("speech server unreachable — run npm run stt:serve"));
      });
      await new Promise((res, rej) => { // the proxy sends session.update on connect
        ws.onmessage = (ev) => {
          const m = JSON.parse(ev.data);
          if (m.type === "session.updated") res();
          else if (m.type === "error") rej(new Error(m.error?.message ?? "speech server error"));
        };
      });
      final = new Promise((res, rej) => { resolve = res; reject = rej; });
      let partial = "";
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "conversation.item.input_audio_transcription.delta") {
          partial += String(m.delta ?? m.text ?? ""); // deltas are snippets, not the full prefix
          if (state === "recording") onPartial(partial); // ignore late deltas after release
        } else if (m.type === "conversation.item.input_audio_transcription.completed") {
          resolve(String(m.transcript ?? ""));
        } else if (m.type === "error") {
          reject(new Error(m.error?.message ?? "speech server error"));
        }
      };
      ws.onclose = () => reject(new Error("speech server connection lost"));
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
          const v = Math.max(-1, Math.min(1, f32[i]));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        pcmBytes += pcm.byteLength;
        if (ws.readyState === 1) ws.send(pcm.buffer); // 256ms @ 16kHz
      };
      const sink = ctx.createGain(); // ScriptProcessor only runs when connected; gain 0 = silent
      sink.gain.value = 0;
      ctx.createMediaStreamSource(stream).connect(proc);
      proc.connect(sink).connect(ctx.destination);
      return true;
    } catch (err) {
      onError?.(`mic: ${err.message}`);
      stop();
      return false;
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close();
    ws?.close();
    stream = ctx = ws = null;
  }

  async function release() {
    const wasRecording = state === "recording";
    setMic("transcribing", "transcribing…");
    if (wasRecording) onRelease?.();
    // onaudioprocess fires every 256ms; the drain keeps streaming the tail of
    // the utterance (and the RNN-T right-context frames) before committing.
    await new Promise((r) => setTimeout(r, 300));
    if (pcmBytes < 8000) { stop(); setMic("idle", IDLE_TITLE); onCancel?.(); return; } // accidental tap
    if (ws?.readyState !== 1) reject?.(new Error("speech server unreachable — run npm run stt:serve"));
    else ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    try {
      const text = await Promise.race([
        final,
        new Promise((_, rej) => setTimeout(() => rej(new Error("speech server timed out")), 30000)),
      ]);
      onFinal(text.trim());
    } catch (err) {
      onError?.(`voice: ${err.message}`);
    } finally {
      stop();
      setMic("idle", IDLE_TITLE);
    }
  }

  function press() {
    if (state !== "idle" || (canStart && !canStart())) return;
    releaseWhileStarting = false;
    setMic("starting", "Release to transcribe");
    onPress?.();
    void start().then((ok) => {
      if (!ok) { setMic("idle", IDLE_TITLE); return; }
      setMic("recording", "Release to transcribe");
      if (releaseWhileStarting) { void release(); return; }
      onStart?.();
    });
  }

  function lift() {
    if (state === "starting") { releaseWhileStarting = true; onRelease?.(); return; }
    if (state === "recording") { void release(); return; }
    releaseWhileStarting = true;
  }

  button.addEventListener("pointerdown", (e) => {
    if (state !== "idle") return;
    e.preventDefault();
    try { button.setPointerCapture(e.pointerId); } catch { /* still fine via window listeners */ }
    press();
  });
  button.addEventListener("pointerup", lift);
  button.addEventListener("pointercancel", lift);
  button.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press menu on touch

  // Space-to-talk pages pass holdKey: "Space"; everything else keeps Ctrl+M.
  if (holdKey === "Space") {
    const inField = (e) => e.target instanceof Element
      && e.target.closest("input, textarea, select, [contenteditable='true']");
    window.addEventListener("keydown", (e) => {
      if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || inField(e)) return;
      e.preventDefault(); // stop page scroll and button activation while holding
      if (e.repeat || state !== "idle") return;
      press();
    });
    window.addEventListener("keyup", (e) => {
      if (e.code !== "Space") return;
      lift();
    });
  } else {
    // Hold Ctrl+M anywhere on the page (typing included) to record; release to
    // transcribe. Ctrl only — Cmd+M minimizes the window on macOS.
    window.addEventListener("keydown", (e) => {
      if (e.code !== "KeyM" || !e.ctrlKey) return;
      // Cancel even repeat keydowns: WebKit maps Ctrl+M to CR, and an unprevented
      // one in a focused input submits the form — once per auto-repeat.
      e.preventDefault();
      if (e.repeat || state !== "idle") return;
      press();
    });
    window.addEventListener("keyup", (e) => {
      if (state !== "recording" && state !== "starting") { releaseWhileStarting = true; return; }
      // Stop when the trigger key releases first, or the modifier does.
      if (e.code === "KeyM" || !e.ctrlKey) lift();
    });
  }
  // No keyup will arrive if focus leaves the page mid-hold; stop and transcribe.
  window.addEventListener("blur", () => { if (state === "recording") void release(); });
}
