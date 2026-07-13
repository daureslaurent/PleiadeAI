import { RefreshCcwDot } from 'lucide-react';
import { Section } from '../../../components/ui';
import { UpdatePanel } from '../../../components/UpdatePanel';
import { useSettings } from '../context';
import { SettingNumber, SettingToggle } from '../controls';

/** `/settings/system` — the host self-update bridge (git pull + rebuild). Off by default. */
export function SystemPanel() {
  const { form } = useSettings();

  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Updates" icon={<RefreshCcwDot size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Pull the latest master and rebuild the stack from here. Requires the host update watcher
          (tools/updater).
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="update_enabled"
            label="Enable app updates"
            hint="Master switch for the update check and the 'Update app' action. Off by default — the host watcher must also be installed."
          />
          <SettingNumber
            field="update_check_interval_hours"
            label="Check interval (hours)"
            hint="How often the backend runs a read-only update check (git fetch + compare). Minimum 1."
            min={1}
          />
          <div className="border-t border-white/[0.06] pt-4">
            <UpdatePanel enabled={form.update_enabled} />
          </div>
        </div>
      </Section>
    </div>
  );
}
