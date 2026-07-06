/**
 * Minimal ambient types for noVNC's core RFB client (`@novnc/novnc` ships ESM with no `.d.ts`).
 * Declares only the surface the Visual panel uses. RFB extends an EventTarget, so `addEventListener`
 * gives us `connect` / `disconnect` / `securityfailure` / `credentialsrequired` events.
 */
declare module '@novnc/novnc' {
  interface RFBCredentials {
    username?: string;
    password?: string;
    target?: string;
  }
  interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string, options?: RFBOptions);
    /** When true the canvas renders but swallows all local mouse/keyboard input. */
    viewOnly: boolean;
    /** Scale the remote framebuffer to fit the target element. */
    scaleViewport: boolean;
    /** Clip (rather than scale) the framebuffer to the target element. */
    clipViewport: boolean;
    /** Ask the server to resize its session to the target element's size. */
    resizeSession: boolean;
    /** CSS background painted behind the framebuffer. */
    background: string;
    qualityLevel: number;
    compressionLevel: number;
    disconnect(): void;
    sendCredentials(credentials: RFBCredentials): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
  }
}
