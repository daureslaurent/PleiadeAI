import { Eye, Image, Server, SlidersHorizontal } from 'lucide-react';
import { Field, Section } from '../../../components/ui';
import { EndpointsManager } from '../managers/EndpointsManager';
import { useSettings } from '../context';
import {
  EndpointModelPicker,
  SettingNullableNumber,
  SettingNumber,
  SettingSlider,
  SettingToggle,
} from '../controls';

/** `/settings/inference` — the model servers and how agents sample from them. */
export function InferencePanel() {
  const { form, endpoints } = useSettings();

  const def = endpoints.find((e) => e.is_default);
  const defaultModel = def?.default_model || def?.models[0] || '—';

  return (
    <div className="animate-fade-up space-y-5">
      <Section
        title="Endpoints"
        icon={<Server size={13} />}
        right={
          <span className="font-mono text-[10px] text-slate-500">
            {def ? (
              <>
                default: <span className="text-slate-300">{def.name}</span> / {defaultModel}
              </>
            ) : (
              'no default endpoint'
            )}
          </span>
        }
      >
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          OpenAI-compatible servers (llama.cpp, vLLM, Ollama…). Agents pick one, or use the default.
          Give one a fallback priority for automatic failover.
        </p>
        <EndpointsManager />
      </Section>

      <Section title="Generation" icon={<SlidersHorizontal size={13} />}>
        <div className="space-y-4">
          <SettingNumber field="max_tokens" label="Max tokens" hint="Upper bound on generated tokens per turn." min={1} />
          <SettingNumber
            field="max_tool_iterations"
            label="Max tool steps per turn"
            hint="Fleet default for how many tool round-trips an agent may take before a turn is cut off. Each agent can override this on its own page."
            min={1}
          />
          <SettingSlider field="temperature" label="Temperature" min={0} max={2} step={0.05} />
          <SettingSlider field="top_p" label="Top P" min={0} max={1} step={0.01} />
          <SettingToggle
            field="context_window_auto"
            label="Auto-detect context window"
            hint="Read each server's real n_ctx (probed at model discovery) for the chat context meter. Endpoints can override this. When off, the number below is used for every endpoint that inherits."
          />
          <SettingNumber
            field="context_window"
            label="Context window"
            hint={
              form.context_window_auto
                ? 'Fallback n_ctx — used only when a server doesn’t report its context size.'
                : 'Model n_ctx — used to show session context usage in chat.'
            }
            min={1}
          />
          <EndpointModelPicker
            endpointField="title_endpoint_id"
            modelField="title_model"
            label="Title generation model"
            noneLabel="Agent's own model"
            hint="Model that names new sessions. “Agent's own model” reuses whatever the responding agent used; or pick a specific (e.g. cheaper) endpoint. Failover applies either way."
          />
          <SettingNumber
            field="title_max_tokens"
            label="Title max tokens"
            hint="Token budget for the title call. Reasoning models spend tokens on a <think> block first, so keep this generous (≥256) — too low truncates mid-reasoning and produces no title."
            min={32}
          />
        </div>
      </Section>

      <Section title="Vision" icon={<Eye size={13} />}>
        <div className="space-y-4">
          <EndpointModelPicker
            endpointField="vision_endpoint_id"
            modelField="vision_model"
            label="Vision endpoint (for visual agents)"
            noneLabel="None — visual agents can't see the screen"
            warnUnlessVision
            hint="Screenshots from visual_screenshot are analysed here and returned to the agent as text + coordinates. Pick an endpoint whose model supports vision (llama.cpp with --mmproj)."
          />
          <Field
            label="Vision sampling"
            hint="Sampling for the vision analysis call. Leave a box blank to disable it — that parameter is then not sent, so the model server uses its own default."
          >
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <SettingNullableNumber field="vision_temperature" label="temperature" min={0} step={0.05} />
              <SettingNullableNumber field="vision_top_p" label="top_p" min={0} max={1} step={0.05} />
              <SettingNullableNumber field="vision_max_tokens" label="max_tokens" min={1} step={1} />
              <SettingNullableNumber field="vision_frequency_penalty" label="frequency_penalty" step={0.1} />
              <SettingNullableNumber field="vision_presence_penalty" label="presence_penalty" step={0.1} />
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Image generation" icon={<Image size={13} />}>
        <EndpointModelPicker
          endpointField="image_endpoint_id"
          modelField="image_model"
          label="Image endpoint (for generate_image)"
          noneLabel="None — generate_image is unavailable"
          hint="The generate_image tool sends prompts here (POST /v1/images/generations). Point it at an OpenAI-compatible image server — e.g. the bundled image-gen/ stable-diffusion.cpp FLUX box. Per-image defaults (size/steps/guidance) live on the Tools page."
        />
      </Section>
    </div>
  );
}
