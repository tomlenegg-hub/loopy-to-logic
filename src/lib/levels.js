// Loopy stores send amounts, group/track volumes and bus/master gain as linear gain (1.0 = 0 dB).
// Logic's faders, send knobs and aux levels are in dB, so everything user-facing is converted here.
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

/** "−3.0 dB", "+4.0 dB", "0.0 dB", or "off (−∞)" for zero. Rounded to 0.1 dB, true minus sign. */
export function fmtDb(gain) {
  if (!(gain > 0)) return 'off (−∞)';
  let d = Math.round(gainToDb(gain) * 10) / 10;
  if (Object.is(d, -0) || d === 0) d = 0;
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d).toFixed(1)} dB`;
}

/** Whether a gain differs from unity by a visible amount (more than 0.05 dB). */
export const isUnity = (gain) => Number.isFinite(gainToDb(gain)) && Math.abs(gainToDb(gain)) < 0.05;

/** Automation: CC value n (0–127) corresponds to linear gain n/128 (38 -> 0.296875 -> −10.5 dB). */
export const ccToGain = (n) => n / 128;
