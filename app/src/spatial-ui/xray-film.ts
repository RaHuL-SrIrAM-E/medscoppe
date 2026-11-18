import { XRAY_NOTICE, type XrayFinding } from '../consult/ui/condition-reference.js';

/**
 * Draws an ILLUSTRATIVE chest film schematic onto a canvas. Nothing here is a patient image or derived from one: it is
 * a stylised thorax (lungs, ribs, spine, heart, diaphragm) with one finding painted over it and circled. Film left is
 * the patient's right, as on a real PA film. The bottom band carries the finding text and a permanent illustrative label.
 */
export const FILM_W = 640;
export const FILM_H = 900;
export const FIELD_H = 640; // the film itself; the rest is the caption band

type Ctx = CanvasRenderingContext2D;

const blob = (c: Ctx, x: number, y: number, r: number, alpha: number, color = '255,255,255'): void => {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${color},${alpha})`);
  g.addColorStop(1, `rgba(${color},0)`);
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
};

function wrap(c: Ctx, text: string, x: number, y: number, maxWidth: number, lineHeight: number): number {
  let line = '';
  let yy = y;
  for (const word of text.split(' ')) {
    const test = line ? `${line} ${word}` : word;
    if (c.measureText(test).width > maxWidth && line) {
      c.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else line = test;
  }
  if (line) c.fillText(line, x, yy);
  return yy + lineHeight;
}

export function drawChestFilm(c: Ctx, finding: XrayFinding, conditionName: string): void {
  const X = (v: number): number => v * FILM_W;
  const Y = (v: number): number => v * FIELD_H;
  const inflated = finding.pattern === 'HYPERINFLATION';
  const failing = finding.pattern === 'CARDIAC_CONGESTION';

  c.clearRect(0, 0, FILM_W, FILM_H);
  c.fillStyle = '#07090c';
  c.fillRect(0, 0, FILM_W, FILM_H);

  // soft tissue of the thorax
  c.fillStyle = '#4a4f56';
  c.beginPath();
  c.moveTo(X(0.5), Y(0.03));
  c.bezierCurveTo(X(0.25), Y(0.03), X(0.06), Y(0.2), X(0.08), Y(0.55));
  c.bezierCurveTo(X(0.09), Y(0.85), X(0.2), Y(0.99), X(0.5), Y(0.99));
  c.bezierCurveTo(X(0.8), Y(0.99), X(0.91), Y(0.85), X(0.92), Y(0.55));
  c.bezierCurveTo(X(0.94), Y(0.2), X(0.75), Y(0.03), X(0.5), Y(0.03));
  c.fill();

  // lung fields (air is dark)
  const top = inflated ? 0.1 : 0.14;
  const bottom = inflated ? 0.86 : 0.79;
  const lung = (cx: number, rx: number): void => {
    const g = c.createLinearGradient(0, Y(top), 0, Y(bottom));
    g.addColorStop(0, inflated ? '#0b0d10' : '#15181c');
    g.addColorStop(1, inflated ? '#101216' : '#1d2126');
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(X(cx), Y((top + bottom) / 2), X(rx), Y((bottom - top) / 2), 0, 0, Math.PI * 2);
    c.fill();
  };
  lung(0.34, inflated ? 0.2 : 0.175);
  lung(0.66, inflated ? 0.2 : 0.175);

  // ribs: pale arcs across each lung field
  c.strokeStyle = 'rgba(190,196,204,0.3)';
  c.lineWidth = 4;
  for (let i = 0; i < 8; i++) {
    const y0 = 0.16 + i * (inflated ? 0.082 : 0.075);
    for (const side of [-1, 1]) {
      c.beginPath();
      c.moveTo(X(0.5 + side * 0.05), Y(y0));
      c.quadraticCurveTo(X(0.5 + side * 0.28), Y(y0 - 0.03 + (inflated ? 0 : 0.015)), X(0.5 + side * 0.4), Y(y0 + (inflated ? 0.03 : 0.09)));
      c.stroke();
    }
  }
  // clavicles
  c.strokeStyle = 'rgba(210,214,220,0.5)';
  c.lineWidth = 7;
  for (const side of [-1, 1]) {
    c.beginPath();
    c.moveTo(X(0.5 + side * 0.04), Y(0.14));
    c.quadraticCurveTo(X(0.5 + side * 0.2), Y(0.1), X(0.5 + side * 0.38), Y(0.17));
    c.stroke();
  }
  // mediastinum, trachea and spine
  c.fillStyle = 'rgba(120,126,134,0.9)';
  c.fillRect(X(0.46), Y(0.1), X(0.08), Y(0.78));
  c.fillStyle = '#0a0c0f';
  c.fillRect(X(0.485), Y(0.1), X(0.03), Y(0.22));
  c.fillStyle = 'rgba(170,176,184,0.55)';
  for (let i = 0; i < 14; i++) c.fillRect(X(0.475), Y(0.1 + i * 0.054), X(0.05), Y(0.03));
  // heart
  c.fillStyle = 'rgba(128,134,142,0.95)';
  c.beginPath();
  const hr = failing ? 0.17 : inflated ? 0.07 : 0.11;
  c.ellipse(X(0.5 + hr * 0.55), Y(inflated ? 0.7 : 0.67), X(hr), Y(inflated ? 0.17 : failing ? 0.15 : 0.13), -0.2, 0, Math.PI * 2);
  c.fill();
  // diaphragm domes (lower edge of the lungs)
  c.strokeStyle = 'rgba(200,205,212,0.55)';
  c.lineWidth = 6;
  for (const side of [-1, 1]) {
    c.beginPath();
    c.moveTo(X(0.5 + side * 0.04), Y(bottom + (inflated ? 0 : -0.02)));
    c.quadraticCurveTo(X(0.5 + side * 0.2), Y(bottom + (inflated ? 0.01 : -0.08)), X(0.5 + side * 0.36), Y(bottom + (inflated ? 0.0 : 0.0)));
    c.stroke();
  }

  // the finding
  const mx = X(finding.marker.x);
  const my = Y(finding.marker.y);
  switch (finding.pattern) {
    case 'CONSOLIDATION':
      blob(c, mx, my, 70, 0.7);
      blob(c, mx - 28, my + 24, 44, 0.55);
      blob(c, mx + 22, my - 26, 38, 0.5);
      // air bronchogram: thin dark branching lines inside the opacity
      c.strokeStyle = 'rgba(8,10,12,0.55)';
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(mx + 30, my - 28); c.lineTo(mx, my); c.lineTo(mx - 24, my + 16);
      c.moveTo(mx, my); c.lineTo(mx + 4, my + 34);
      c.stroke();
      break;
    case 'UPPER_CAVITY':
      blob(c, mx, my, 64, 0.55);
      blob(c, mx - 22, my + 30, 30, 0.45);
      c.strokeStyle = 'rgba(235,238,242,0.8)';
      c.lineWidth = 5;
      c.fillStyle = '#0b0d10';
      c.beginPath();
      c.ellipse(mx + 4, my - 2, 22, 18, 0.3, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      break;
    case 'HYPERINFLATION':
      // the finding IS the whole-lung appearance: a faint bracket on each lung marks the flat, low diaphragm
      c.strokeStyle = 'rgba(124,242,212,0.0)';
      break;
    case 'CARDIAC_CONGESTION':
      for (const side of [-1, 1]) {
        blob(c, X(0.5 + side * 0.14), Y(0.55), 90, 0.5);
        blob(c, X(0.5 + side * 0.2), Y(0.68), 70, 0.4);
        blob(c, X(0.5 + side * 0.31), Y(bottom - 0.01), 42, 0.7); // blunted costophrenic angle
      }
      break;
    case 'MASS':
      blob(c, mx, my, 40, 0.95);
      c.fillStyle = 'rgba(250,250,252,0.85)';
      c.beginPath();
      c.arc(mx, my, 23, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = 'rgba(250,250,252,0.7)';
      c.lineWidth = 3;
      for (let a = 0; a < Math.PI * 2; a += 0.7) {
        c.beginPath();
        c.moveTo(mx + Math.cos(a) * 23, my + Math.sin(a) * 23);
        c.lineTo(mx + Math.cos(a) * 36, my + Math.sin(a) * 36);
        c.stroke();
      }
      break;
  }

  // circle the finding (an annotation, not part of the "film")
  const ring = finding.pattern === 'HYPERINFLATION' || finding.pattern === 'CARDIAC_CONGESTION' ? 150 : 76;
  c.setLineDash([14, 10]);
  c.strokeStyle = '#7cf2d4';
  c.lineWidth = 5;
  c.beginPath();
  if (ring > 100) c.ellipse(mx, my, X(0.38), Y(0.34), 0, 0, Math.PI * 2);
  else c.arc(mx, my, ring, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);

  // orientation markers: film left is the patient's right
  c.fillStyle = '#c9ced4';
  c.font = '700 34px sans-serif';
  c.fillText('R', X(0.04), Y(0.07));
  c.fillText('L', X(0.93), Y(0.07));

  // caption band
  c.fillStyle = '#0e1622';
  c.fillRect(0, FIELD_H, FILM_W, FILM_H - FIELD_H);
  c.fillStyle = '#ffb454';
  c.font = '700 20px sans-serif';
  c.fillText(XRAY_NOTICE, 18, FIELD_H + 30);
  c.fillStyle = '#7cf2d4';
  c.font = '700 28px sans-serif';
  const next = wrap(c, `${conditionName}: ${finding.title}`, 18, FIELD_H + 66, FILM_W - 36, 32);
  c.fillStyle = '#dbe8f5';
  c.font = '24px sans-serif';
  wrap(c, finding.look, 18, next + 10, FILM_W - 36, 30);
}
