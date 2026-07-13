import { MonitorCog } from 'lucide-react';
import { Section, Toggle } from '../../../components/ui';
import { usePrefs } from '../../../store/prefs';

/**
 * `/settings/interface` — client-side display preferences. These live in localStorage (`store/prefs`),
 * not the settings doc: they apply instantly on this device and are never sent to the backend.
 */
export function InterfacePanel() {
  const showSubagentThinking = usePrefs((s) => s.showSubagentThinking);
  const setShowSubagentThinking = usePrefs((s) => s.setShowSubagentThinking);

  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Display" icon={<MonitorCog size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Saved on this device only — they don't affect agents or other browsers.
        </p>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm text-slate-200">Show sub-agent thinking</div>
            <div className="mt-1 text-[11px] leading-relaxed text-slate-500">
              Render the collapsible reasoning block for delegated sub-agents. The top-level agent's
              thinking is always shown.
            </div>
          </div>
          <div className="mt-0.5">
            <Toggle checked={showSubagentThinking} onChange={setShowSubagentThinking} />
          </div>
        </div>
      </Section>
    </div>
  );
}
