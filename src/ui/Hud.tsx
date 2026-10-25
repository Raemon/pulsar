// HUD shell. React owns the markup; src/game/hud.ts continues to write
// textContent / classList by ID for per-frame updates. The IDs and classes
// here are the contract — keep them in sync with hud.ts.
//
// Tailwind utilities replace the bulk of style.css for layout; complex
// pieces (the score-flash keyframe + --scale/--glow CSS vars, the powerup
// pop animation, mix-blend-mode, the radial backdrop on overlay) stay in
// style.css under their original selectors.

const Powerup = ({ kind, title, children, withProgress = false }: {
  kind: string;
  title: string;
  children: React.ReactNode;
  withProgress?: boolean;
}) => (
  <div className="powerup-slot" data-kind={kind} title={title}>
    {children}
    {withProgress && <div className="powerup-progress" />}
  </div>
);

export const Hud = () => (
  <div id="hud">
    <div id="hud-left">
      <div id="wave">WAVE 1</div>
      <div id="lives">
        <span /><span /><span />
      </div>
      <div id="fuel" className="hidden">
        <span id="fuel-label">fuel</span>
        <div id="fuel-bar">
          <div id="fuel-fill" />
        </div>
      </div>
      <div id="score-block">
        <div id="score-row">
          <div id="score">0</div>
          <div id="score-flash" aria-hidden="true" />
        </div>
        <div id="combo" className="hidden">
          <span id="combo-value">0</span>
          <span id="combo-label">rhythm</span>
        </div>
      </div>
    </div>
    <div id="powerups">
      <Powerup kind="prong" title="Prong — two-bullet spread">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4 L7 11 L9 13 M17 4 L17 11 L15 13 M9 13 L15 13 M12 13 L12 21 M9 19 L15 19" />
        </svg>
      </Powerup>
      <Powerup kind="rapid" title="Rapid Fire — eighth-note cadence">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 12 L10 12 M6 7 L12 12 L6 17 M12 7 L18 12 L12 17 M18 7 L20 9" />
        </svg>
      </Powerup>
      <Powerup kind="pierce" title="Pierce — bullets cut through">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="8" cy="12" r="2.5" />
          <circle cx="16" cy="12" r="2.5" />
          <path d="M2 12 L22 12 M19 9 L22 12 L19 15" />
        </svg>
      </Powerup>
      <Powerup kind="shield" title="Shield — absorbs one hit">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 L20 6 L20 12 Q20 17 12 21 Q4 17 4 12 L4 6 Z" />
          <path d="M12 8 L12 16 M8 12 L16 12" opacity="0.6" />
        </svg>
      </Powerup>
      <Powerup kind="slow" title="Slow-Mo — time dilation" withProgress>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="13" r="7" />
          <path d="M12 13 L12 8 M12 13 L16 15 M9 3 L15 3 M12 3 L12 6" />
        </svg>
      </Powerup>
      <Powerup kind="radar" title="Radar — double cone angle & range">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 21 L3 6 L21 6 Z" />
          <path d="M12 21 L7.5 13.5 M12 21 L16.5 13.5" opacity="0.55" />
          <circle cx="12" cy="21" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      </Powerup>
      <Powerup kind="longshot" title="Farshot — double bullet range, second reticule 2 beats out">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="2" />
          <circle cx="17" cy="12" r="2" />
          <path d="M2 12 L22 12 M19 9 L22 12 L19 15" />
        </svg>
      </Powerup>
      <Powerup kind="bomb" title="Bomb — shots become mines that pulse on the beat and blast everything in range">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="14" r="7" />
          <path d="M15 8 L18 5 M18 5 L21 3 M18 5 L20 7" />
        </svg>
      </Powerup>
    </div>
    <div id="hud-right">
      <input
        id="volume"
        type="range"
        min="0"
        max="200"
        defaultValue="200"
        title="Volume (M to toggle)"
        aria-label="Volume"
      />
    </div>
    <div id="debug-overlay" className="hidden"></div>
    <div id="debug-fps">FPS --</div>
  </div>
);
