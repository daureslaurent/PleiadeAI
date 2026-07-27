import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Smartphone } from 'lucide-react';
import {
  AndroidScreen,
  MirrorControls,
  StatusPill,
} from '../components/workspace/AndroidPanel';
import { useAndroidMirror } from '../components/workspace/useAndroidMirror';

/**
 * Chrome-free, full-window live phone mirror for one agent — the popped-out counterpart of
 * `AndroidPanel`. Mounted at `/phone/:agentId` outside the app layout (no sidebar/header) and opened
 * via `window.open`. Same origin as the app, so it shares the auth token; closing the browser window
 * drops the WebSocket, which is what ends the scrcpy session (the hook also releases manual control
 * on unmount, so the agent isn't left locked out).
 */
export function AndroidPhoneWindow() {
  const { agentId = '' } = useParams();
  const [params] = useSearchParams();
  const agentName = params.get('name') || 'Agent';
  const mirror = useAndroidMirror(agentId);

  useEffect(() => {
    document.title = `${agentName} · Phone`;
  }, [agentName]);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#0b0f19]">
      <div className="flex items-center gap-2 border-b border-slate-800 bg-panel px-3 py-2">
        <Smartphone size={15} className="text-reasoning" />
        <span className="truncate text-sm font-medium text-slate-200">{agentName} · Phone</span>
        <StatusPill status={mirror.status} />
        <div className="ml-auto flex items-center gap-1.5">
          <MirrorControls mirror={mirror} />
        </div>
      </div>

      <AndroidScreen mirror={mirror} />

      <div className="border-t border-slate-800 bg-panel px-3 py-1.5 text-[11px] text-slate-500">
        {mirror.takeover
          ? 'You are driving. Taps and keystrokes go to the device — the agent’s android_act stands down until you release.'
          : mirror.info
            ? `View only — watching ${mirror.info.device || mirror.info.deviceName} at ${mirror.info.width}×${mirror.info.height}.`
            : 'View only — watching the agent. Take control to intervene.'}
      </div>
    </div>
  );
}
