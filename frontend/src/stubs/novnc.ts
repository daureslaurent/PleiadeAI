/**
 * Stand-in for `@novnc/novnc` when `VITE_FEATURE_NOVNC=0` (see `lib/features.ts`).
 *
 * `vite.config.ts` resolves the package specifier here. The single import site
 * (`components/workspace/useVisualDesktop.ts`) is guarded by `NOVNC_ENABLED` and reports the desktop
 * as unavailable instead of constructing this; the class exists only so the module graph resolves
 * and the `RFB` type keeps its shape.
 */
export default class RFB {
  viewOnly = true;
  scaleViewport = false;
  background = '';

  constructor(_target: HTMLElement, _url: string, _options?: unknown) {
    throw new Error('The live desktop was not included in this build (VITE_FEATURE_NOVNC=0).');
  }

  addEventListener(_type: string, _listener: (e: Event) => void): void {}
  disconnect(): void {}
  sendCtrlAltDel(): void {}
}
