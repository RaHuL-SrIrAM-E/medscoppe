/**
 * Fixed wording for the consultation UI. Kept in one place so tests can assert on it and so nothing can quietly
 * soften the replay label. The em dash is the wording the product owner specified; see `uiDash` for the font fallback.
 */
export const EM_DASH = '—';

export const uiDash = (): string => EM_DASH;

/**
 * The UI font atlas has no em dash ("Missing glyph info for character" in the console, boxes on screen), so anything
 * painted into a UIKit panel goes through this. Logical strings, tests and logs keep the specified em dash.
 */
export const toUiText = (s: string): string => s.split(EM_DASH).join('-');

export const LABELS = {
  data: `SCRIPTED CONSULTATION ${uiDash()} SYNTHETIC DATA`,
  replay: `RECORDED REPLAY ${uiDash()} NOT A LIVE GEMINI RESPONSE`,
  mixed: `MIXED ${uiDash()} PART RECORDED REPLAY, PART LIVE MODEL`,
  checking: 'EXTRACTION: checking backend...',
  notStarted: 'EXTRACTION: not started',
} as const;

export const liveLabel = (provider: string | null, model: string | null): string =>
  `LIVE MODEL RESPONSE (${[provider, model].filter(Boolean).join(' ') || 'backend'})`;
