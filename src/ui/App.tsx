import { Hud } from "./Hud";
import { Overlay } from "./Overlay";
import { FirstWaveHint } from "./FirstWaveHint";
import { TutorialControlsHint } from "./TutorialControlsHint";
import { BeatCalibrator } from "./BeatCalibrator";
import { IntroSequence } from "./IntroSequence";
import { SettingsDialog } from "./SettingsDialog";
import { PauseButton } from "./PauseButton";
import { TouchControls } from "./TouchControls";
import { ReplayScrubber } from "./ReplayScrubber";

export const App = () => (
  <>
    <Hud />
    <Overlay />
    <ReplayScrubber />
    <FirstWaveHint />
    <TutorialControlsHint />
    <BeatCalibrator />
    <IntroSequence />
    <SettingsDialog />
    <PauseButton />
    <TouchControls />
  </>
);
