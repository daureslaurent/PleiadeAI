import { Section } from '../../../components/ui';
import { ApiSourcesManager } from '../managers/ApiSourcesManager';

/**
 * `/settings/apis` — the HTTP APIs agents may call (`API_TOOL_PLAN.md`).
 *
 * Everything an agent can reach through the `api` tool is defined here and nowhere else: it names an
 * operation from `api_man` and fills its parameters, so what you configure on this page is exactly
 * the surface it has. Nothing is reachable by default.
 */
export function ApisPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Configured APIs">
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          An agent granted the <code className="font-mono">api_man</code> and{' '}
          <code className="font-mono">api</code> tools sees every API switched on here. It reads the
          catalogue, picks an operation by name — <code className="font-mono">weather.forecast</code> — and
          fills the parameters you declared; it never composes a URL and never sees a credential. Write verbs
          are off until you tick them, and the parameter descriptions you write are what the model reads
          before choosing a value, so they are worth the sentence.
        </p>
        <ApiSourcesManager />
      </Section>
    </div>
  );
}
