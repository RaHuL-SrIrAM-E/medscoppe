import { createSystem, type UIKit, type UIKitMLAsset } from '@iwsdk/core';
import { consultApp } from '../consult/app/consult-singleton.js';
import type { AppSnapshot } from '../consult/app/consult-app.js';
import { toUiText } from '../consult/ui/consult-labels.js';
import type { ControlLifecycle } from '../consult/ui/consult-view-model.js';
import { intentBus, type IntentSource } from '../core/intents.js';

const STATE_COLOUR: Record<ControlLifecycle, string> = {
  READY: '#9db3c9',
  STARTING: '#f2c14e',
  LISTENING: '#7cf2d4',
  PAUSED: '#f2c14e',
  ENDED: '#9db3c9',
  COMPLETE: '#7cf2d4',
  FAILED: '#ff8a7a',
};

const BUTTON_LIVE = '#7cf2d4';
const BUTTON_IDLE = '#2a3b52';

/**
 * Near-field consultation controls: start, pause, resume, end, and the two labels that must always be visible (scripted
 * synthetic data, and what the extraction really is). It only emits intents and paints what ConsultApp derived.
 */
export class ConsultControlsSystem extends createSystem({}) {
  private panel: UIKitMLAsset | null = null;
  private els: Record<string, UIKit.Text | null> = {};
  private primary: ReturnType<UIKitMLAsset['getElementById']> = null;
  private end: ReturnType<UIKitMLAsset['getElementById']> = null;
  private retry: ReturnType<UIKitMLAsset['getElementById']> = null;
  private lastRevision = -1;

  private source(): IntentSource {
    return this.renderer.xr.isPresenting ? 'hand' : 'desktop';
  }

  update(): void {
    if (!this.panel) {
      this.tryBind();
      return;
    }
    const snap = consultApp.getSnapshot();
    if (snap.revision !== this.lastRevision) {
      this.lastRevision = snap.revision;
      this.paint(snap);
    }
  }

  private tryBind(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>('consult-controls');
    if (!panel) return;
    for (const id of ['data-label', 'extraction-label', 'extraction-detail', 'state-label', 'busy-label', 'consult-btn-primary-label', 'consult-btn-end-label', 'caption', 'error', 'notice']) {
      this.els[id] = panel.getElementById<UIKit.Text>(id);
    }
    this.primary = panel.getElementById('consult-btn-primary');
    this.end = panel.getElementById('consult-btn-end');
    this.retry = panel.getElementById('consult-btn-retry');
    const wire = (el: typeof this.primary, handler: () => void): void => {
      if (!el) return;
      el.addEventListener('click', handler);
      this.cleanupFuncs.push(() => el.removeEventListener('click', handler));
    };
    wire(this.primary, () => {
      const action = consultApp.getSnapshot().controls.primary.action;
      if (action !== 'NONE') intentBus.emit({ type: action }, this.source());
    });
    wire(this.end, () => intentBus.emit({ type: 'END_CONSULTATION' }, this.source()));
    wire(this.retry, () => intentBus.emit({ type: 'RETRY_EXTRACTION' }, this.source()));
    this.panel = panel;
    this.paint(consultApp.getSnapshot());
  }

  private paint(snap: AppSnapshot): void {
    const c = snap.controls;
    const set = (id: string, props: Record<string, unknown>): void => this.els[id]?.setProperties(props);
    const show = (text: string | null) => ({ text: text ?? '', display: text ? 'flex' : 'none' });

    set('data-label', { text: toUiText(c.dataLabel) });
    set('extraction-label', { text: toUiText(c.extractionLabel), color: c.extractionIsReplay ? '#ffb454' : '#7cf2d4' });
    set('extraction-detail', show(c.extractionDetail));
    set('state-label', { text: c.lifecycleText, color: STATE_COLOUR[c.lifecycle] });
    set('busy-label', show(c.busyLine));
    set('consult-btn-primary-label', { text: c.primary.label, color: c.primary.action === 'NONE' ? '#6f8399' : '#e8f3ff' });
    this.primary?.setProperties({ borderColor: c.primary.action === 'NONE' ? BUTTON_IDLE : BUTTON_LIVE });
    this.end?.setProperties({ display: c.end ? 'flex' : 'none' });
    this.retry?.setProperties({ display: c.retry ? 'flex' : 'none' });
    set('caption', show(c.caption));
    set('error', show(c.errorLine));
    set('notice', show(snap.notice));
  }
}
