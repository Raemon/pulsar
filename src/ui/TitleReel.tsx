// Chrome for the home screen's highlight reel (game/titleReel.ts drives both
//   of these imperatively, the way the rest of the overlay works).
//
//   #reel-veil sits between the gameplay canvas and the overlay. It is the
//   reel's shutter: opaque while the re-sim catches up to a clip's first frame,
//   transparent while the clip plays, so the viewer only ever sees gameplay at
//   its intended speed.
//
//   #reel-caption credits the run on screen and tracks the rhythm as it climbs,
//   so the number in the corner explains the halo growing around the ship.
export const TitleReel = () => (
  <>
    <div id="reel-veil" />
    <div id="reel-caption">
      <span className="reel-caption-pilot" />
      <span className="reel-caption-rhythm">
        <span className="reel-caption-live" />
        <span className="reel-caption-peak" />
      </span>
    </div>
  </>
);
