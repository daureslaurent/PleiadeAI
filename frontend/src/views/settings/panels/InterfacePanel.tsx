import { useState } from 'react';
import { LayoutTemplate, MonitorCog, Palette, PanelLeft } from 'lucide-react';
import { Field, Input, Section, Toggle } from '../../../components/ui';
import { SESSIONS_PER_AGENT_MAX, SESSIONS_PER_AGENT_MIN, usePrefs } from '../../../store/prefs';
import { ChatLayoutPicker, ThemePicker } from './AppearanceControls';

/**
 * `/settings/interface` — how the app looks and what it shows.
 *
 * Two kinds of preference share the page. **Appearance** (theme, chat layout) is stored both in
 * localStorage and on the settings doc, so it applies instantly *and* follows the operator to
 * another browser. The **Display** toggles below it stay local: they are about this screen.
 */
export function InterfacePanel() {
  const showSubagentThinking = usePrefs((s) => s.showSubagentThinking);
  const setShowSubagentThinking = usePrefs((s) => s.setShowSubagentThinking);
  const sessionsPerAgent = usePrefs((s) => s.sessionsPerAgent);
  const setSessionsPerAgent = usePrefs((s) => s.setSessionsPerAgent);
  // The number field is edited as free text (so it can be cleared mid-typing) and only committed —
  // clamped — on blur; the store is the source of truth the moment it is.
  const [draft, setDraft] = useState(String(sessionsPerAgent));

  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Theme" icon={<Palette size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          The palette, surfaces and type of the whole app. Applies immediately and follows you to
          another browser.
        </p>
        <ThemePicker />
      </Section>

      <Section title="Chat layout" icon={<LayoutTemplate size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          How a turn is structured on the workspace page — where you and the agent speak, and
          whether tool calls, thinking and delegation sit in the reading flow or in a column of
          their own. Independent of the theme.
        </p>
        <ChatLayoutPicker />
      </Section>

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

      <Section title="Workspace navigator" icon={<PanelLeft size={13} />}>
        <Field
          label="Conversations shown per agent"
          hint={`How many recent conversations an expanded agent lists before the rest fold behind "Show more" — and how many each click loads. ${SESSIONS_PER_AGENT_MIN}–${SESSIONS_PER_AGENT_MAX}.`}
          className="max-w-[220px]"
        >
          <Input
            type="number"
            min={SESSIONS_PER_AGENT_MIN}
            max={SESSIONS_PER_AGENT_MAX}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) setSessionsPerAgent(Number(draft));
              // Re-read: an out-of-range or empty entry snaps back to what was actually stored.
              setDraft(String(usePrefs.getState().sessionsPerAgent));
            }}
          />
        </Field>
      </Section>
    </div>
  );
}
