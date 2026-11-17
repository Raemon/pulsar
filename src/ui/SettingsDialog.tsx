import { useEffect, useRef, useState } from "react";
import { loadBeatOffset, clampBeatOffset } from "../game/beatCalibration";
import { getRecentName, saveRecentName } from "../game/highscores";
import { isVeteranPilot, setVeteranPilot } from "../game/veteran";
import {
  CHANNEL_LABELS,
  CHANNEL_ORDER,
  getChannelVolume,
  setChannelVolume,
  type AudioChannel,
} from "../game/audioPrefs";
import {
  ACTION_LABELS,
  ACTION_ORDER,
  BINDING_SLOTS,
  SLOT_LABELS,
  type Bindings,
  type ControlAction,
  chordFromEvent,
  formatKey,
  getBindings,
  isModifierKey as isModifier,
  normalizeKey,
  resetBindings,
  saveBindings,
} from "../game/controlBindings";

// Settings panel opened by the HUD gear. Two tabs:
//   Audio    — per-channel volume + rhythm latency calibration
//   Controls — keyboard bindings
// Callsign and the Show Tutorial toggle sit above the tab strip so they're
// always reachable regardless of which tab is open.

const OFFSET_MIN_MS = -200;
const OFFSET_MAX_MS = 350;
const OFFSET_STEP_MS = 5;

// Each action has BINDING_SLOTS chips (primary / alternate); capture targets one.
type CaptureTarget = { action: ControlAction; slot: number } | null;
type Tab = "audio" | "controls";

const TAB_LABELS: Record<Tab, string> = {
  audio:    "Audio",
  controls: "Controls",
};
const TAB_ORDER: readonly Tab[] = ["audio", "controls"];

export const SettingsDialog = () => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("audio");
  const [offsetMs, setOffsetMs] = useState(0);
  const [callsign, setCallsign] = useState("");
  const [showTutorial, setShowTutorial] = useState(() => !isVeteranPilot());
  const [bindings, setBindings] = useState<Bindings>(() => getBindings());
  const [volumes, setVolumes] = useState<Record<AudioChannel, number>>(() => ({
    basePulse: getChannelVolume("basePulse"),
    sfx:       getChannelVolume("sfx"),
    music:     getChannelVolume("music"),
    vocals:    getChannelVolume("vocals"),
  }));
  const [capture, setCapture] = useState<CaptureTarget>(null);
  const captureRef = useRef<CaptureTarget>(null);
  captureRef.current = capture;

  const openDialog = () => {
    setOffsetMs(Math.round((loadBeatOffset() ?? 0) * 1000));
    setCallsign(getRecentName());
    setShowTutorial(!isVeteranPilot());
    setBindings(getBindings());
    setVolumes({
      basePulse: getChannelVolume("basePulse"),
      sfx:       getChannelVolume("sfx"),
      music:     getChannelVolume("music"),
      vocals:    getChannelVolume("vocals"),
    });
    setCapture(null);
    setOpen(true);
    // freezes the sim if a run is in progress (see Game / updateGame).
    window.dispatchEvent(new CustomEvent("settings:opened"));
  };

  const closeDialog = () => {
    setOpen(false);
    setCapture(null);
    window.dispatchEvent(new CustomEvent("settings:closed"));
  };

  useEffect(() => {
    const onReopen = () => openDialog();
    window.addEventListener("settings:open-request", onReopen);
    return () => window.removeEventListener("settings:open-request", onReopen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // swallow keys at capture so the game behind doesn't act on them; when a
  //   binding capture is active the next key becomes the binding. Modifiers are
  //   special: a modifier keydown is held (not committed) so the player can go
  //   on to press a main key and record a chord (Shift+←). If the player instead
  //   releases the modifier without pressing anything else, its keyup commits it
  //   as a bare binding (precise-turn = Ctrl).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      const target = captureRef.current;
      if (target) {
        e.preventDefault();
        if (e.key === "Escape") { setCapture(null); return; }
        const key = normalizeKey(e.key);
        if (isModifier(key)) return; // wait for the main key (or this key's release)
        applyBinding(target.action, target.slot, chordFromEvent(e, key));
        setCapture(null);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeDialog();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = captureRef.current;
      if (!target) return;
      const key = normalizeKey(e.key);
      if (!isModifier(key)) return;
      // Bare-modifier bind, but only if no other modifier is still held — so
      //   releasing Shift mid-chord-attempt doesn't prematurely bind "shift".
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      e.stopPropagation();
      applyBinding(target.action, target.slot, key);
      setCapture(null);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("keyup", onKeyUp, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKeyUp, true);
    };
  }, [open]);

  const applyOffset = (ms: number) => {
    const clamped = Math.round(clampBeatOffset(ms / 1000) * 1000);
    setOffsetMs(clamped);
    window.dispatchEvent(new CustomEvent("beat-offset:set", { detail: { offsetSec: clamped / 1000 } }));
  };

  const resync = () => {
    // dispatch the request first so `calibrating` latches before `settings:closed`
    //   clears `settingsOpen` — the sim stays frozen across the hand-off mid-run.
    window.dispatchEvent(new CustomEvent("beat-calibrator:request"));
    closeDialog();
  };

  const updateCallsign = (name: string) => {
    const v = name.toUpperCase().slice(0, 16);
    setCallsign(v);
    saveRecentName(v);
  };

  // Slots are positional while editing but stored compacted, so clearing the
  //   primary promotes the alternate rather than leaving a hole.
  const writeSlot = (keys: string[], slot: number, key: string): string[] => {
    const slots = Array.from({ length: BINDING_SLOTS }, (_, i) => keys[i] ?? "");
    slots[slot] = key;
    return slots.filter((k) => k.length > 0);
  };

  const applyBinding = (action: ControlAction, slot: number, key: string) => {
    setBindings((prev) => {
      const next: Bindings = { ...prev } as Bindings;
      // A key belongs to one slot only — strip it from every other slot, including
      //   this action's other slot, so binding W to thrust twice can't happen.
      for (const a of ACTION_ORDER) {
        const filtered = prev[a].filter((k, i) => k !== key || (a === action && i === slot));
        if (filtered.length !== prev[a].length) next[a] = filtered;
      }
      next[action] = writeSlot(next[action], slot, key);
      saveBindings(next);
      return next;
    });
  };

  const clearBinding = (action: ControlAction, slot: number) => {
    setBindings((prev) => {
      const next: Bindings = { ...prev, [action]: writeSlot(prev[action], slot, "") } as Bindings;
      saveBindings(next);
      return next;
    });
  };

  const applyVolume = (channel: AudioChannel, value: number) => {
    const clamped = Math.max(0, Math.min(1, value));
    setVolumes((prev) => ({ ...prev, [channel]: clamped }));
    setChannelVolume(channel, clamped);
  };

  const resetControls = () => {
    resetBindings();
    setBindings(getBindings());
    setCapture(null);
  };

  return (
    <>
      <button id="settings-gear" type="button" title="Settings" aria-label="Settings" onClick={openDialog}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
    <div id="settings-dialog" onClick={closeDialog}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <h2 className="settings-title">Settings</h2>

        <section className="settings-section">
          <label className="settings-field">
            <span>Callsign</span>
            <input
              type="text"
              value={callsign}
              maxLength={16}
              spellCheck={false}
              autoCapitalize="characters"
              placeholder="—"
              onChange={(e) => updateCallsign(e.target.value)}
            />
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={showTutorial}
              onChange={(e) => {
                setShowTutorial(e.target.checked);
                setVeteranPilot(!e.target.checked);
              }}
            />
            <span>Show Tutorial</span>
          </label>
        </section>

        <div className="settings-tabs" role="tablist">
          {TAB_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={`settings-tab${tab === t ? " settings-tab--active" : ""}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>

        {tab === "audio" && (
          <>
            <section className="settings-section">
              <div className="settings-section-head">
                <span className="settings-section-title">Audio Mix</span>
              </div>
              <div className="settings-volume-grid">
                {CHANNEL_ORDER.map((ch) => (
                  <div key={ch} className="settings-volume-row">
                    <span className="settings-volume-label">{CHANNEL_LABELS[ch]}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={volumes[ch]}
                      onChange={(e) => applyVolume(ch, Number(e.target.value))}
                    />
                    <span className="settings-volume-pct">{Math.round(volumes[ch] * 100)}%</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="settings-section">
              <div className="settings-section-head">
                <span className="settings-section-title">Rhythm Latency Calibration</span>
                <button type="button" className="settings-link" onClick={resync}>Resync the beat ▸</button>
              </div>
              <div className="settings-row">
                <div className="settings-latency">
                  <button type="button" className="settings-step" onClick={() => applyOffset(offsetMs - OFFSET_STEP_MS)}>−</button>
                  <input
                    type="range"
                    min={OFFSET_MIN_MS}
                    max={OFFSET_MAX_MS}
                    step={OFFSET_STEP_MS}
                    value={offsetMs}
                    onChange={(e) => applyOffset(Number(e.target.value))}
                  />
                  <button type="button" className="settings-step" onClick={() => applyOffset(offsetMs + OFFSET_STEP_MS)}>+</button>
                  <span className="settings-ms">{offsetMs >= 0 ? "+" : "−"}{Math.abs(offsetMs)} ms</span>
                </div>
              </div>
            </section>
          </>
        )}

        {tab === "controls" && (
          <section className="settings-section">
            <div className="settings-section-head">
              <span className="settings-section-title">Controls</span>
              <button type="button" className="settings-link" onClick={resetControls}>Reset defaults ▸</button>
            </div>
            <p className="settings-note">
              Two keys per action — arrows and WASD are both live by default.
            </p>
            <div className="settings-controls-grid">
              {ACTION_ORDER.map((action) => (
                <div key={action} className="settings-control-row">
                  <span className="settings-control-label">{ACTION_LABELS[action]}</span>
                  <span className="settings-control-keys">
                    {Array.from({ length: BINDING_SLOTS }, (_, slot) => {
                      const k = bindings[action][slot];
                      const isCapturing = capture?.action === action && capture.slot === slot;
                      return (
                        <button
                          key={slot}
                          type="button"
                          className={`settings-key-chip${isCapturing ? " settings-key-chip--listening" : ""}${!k ? " settings-key-chip--empty" : ""}`}
                          onClick={() => setCapture({ action, slot })}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            if (k) clearBinding(action, slot);
                          }}
                          title={`${SLOT_LABELS[slot]} — ${k ? "click to rebind · right-click to clear" : "click to bind"}`}
                        >
                          {isCapturing ? "press a key…" : k ? formatKey(k) : "—"}
                        </button>
                      );
                    })}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        <button type="button" className="settings-done" onClick={closeDialog}>Done</button>
      </div>
    </div>
      )}
    </>
  );
};
