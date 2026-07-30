import { useEffect, useMemo, useRef } from 'react';
import wolfSvg from '../../public/wolf_traced.svg?raw';

// The artwork clips the fill as live vector geometry rather than as a CSS
// mask-image: an SVG used as a mask gets rasterized, and on hi-dpi screens that
// raster is upscaled, which visibly softens line work this thin.
const VIEW_BOX = wolfSvg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
const [VB_X, VB_Y, VB_W, VB_H] = VIEW_BOX;
const WOLF_D = wolfSvg.match(/ d="([^"]+)"/)[1];

// clipPathUnits="objectBoundingBox" needs coordinates in 0..1, so the raw
// potrace space is mapped through its own transform and then normalised.
// Transform lists apply right-to-left.
const CLIP_TRANSFORM = [
  `scale(${1 / VB_W} ${1 / VB_H})`,
  `translate(${-VB_X} ${-VB_Y})`,
  'translate(0 1032)',
  'scale(0.1 -0.1)',
].join(' ');

// Single source of truth for the timeline — handed to CSS as custom properties
// so the keyframes and the unmount timer can never drift apart.
// VEIN outlasts SPREAD on purpose: with the fills overlapping heavily, many
// columns are mid-rise at any moment, so the lit front is a soft arc instead of
// a hard vertical edge between finished and unstarted columns.
const SPREAD_MS = 880; // until the outermost column starts
const VEIN_MS = 1120; // how long one column takes to fill
const FILL_MS = SPREAD_MS + VEIN_MS;
const HOLD_MS = 420;
const FADE_MS = 320;
const REDUCED_MS = 400;
const TOTAL_MS = FILL_MS + HOLD_MS;

// The traced wolf is one compound path — its black web is a single connected
// region, so individual lines cannot be addressed. Instead the fill is split
// into columns: each is clipped to a vertical slice of the artwork and wipes
// upward, and the columns start from the spine outward. The light therefore
// travels up and out through the line work rather than as one circular front.
const COLUMNS = 40;

export default function WolfSplash({ user, onDone }) {
  const done = useRef(onDone);
  done.current = onDone;

  const columns = useMemo(
    () => Array.from({ length: COLUMNS }, (_, i) => {
      const mid = (i + 0.5) / COLUMNS;
      return {
        left: (i / COLUMNS) * 100,
        // Slight overlap keeps subpixel seams from showing between columns.
        width: (100 / COLUMNS) + 0.35,
        delay: (Math.abs(mid - 0.5) / 0.5) * SPREAD_MS,
      };
    }),
    [],
  );

  useEffect(() => {
    const finish = () => done.current();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(finish, reduced ? REDUCED_MS : TOTAL_MS);
    window.addEventListener('pointerdown', finish);
    window.addEventListener('keydown', finish);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('pointerdown', finish);
      window.removeEventListener('keydown', finish);
    };
  }, []);

  return (
    <div
      className="wolf-splash"
      style={{
        '--wolf-vein': `${VEIN_MS}ms`,
        '--wolf-fade': `${FADE_MS}ms`,
        '--wolf-fade-delay': `${TOTAL_MS - FADE_MS}ms`,
      }}
    >
      <svg className="wolf-defs" aria-hidden="true" focusable="false">
        <clipPath id="wolf-clip" clipPathUnits="objectBoundingBox">
          <path transform={CLIP_TRANSFORM} d={WOLF_D} />
        </clipPath>
      </svg>
      <div className="wolf-stage" aria-hidden="true" style={{ aspectRatio: `${VB_W} / ${VB_H}` }}>
        <div className="wolf-layer wolf-base" />
        <div className="wolf-layer wolf-lit">
          {columns.map((c, i) => (
            <span
              key={i}
              className="wolf-col"
              style={{ left: `${c.left}%`, width: `${c.width}%`, animationDelay: `${Math.round(c.delay)}ms` }}
            />
          ))}
        </div>
      </div>
      <p className="wolf-greeting">
        Welcome back, <strong>{user.email}</strong>
      </p>
      <p className="wolf-hint">click anywhere to skip</p>
    </div>
  );
}
