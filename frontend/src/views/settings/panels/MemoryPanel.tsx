import { Brain, Sparkles } from 'lucide-react';
import { Section } from '../../../components/ui';
import { SettingNumber, SettingText, SettingToggle } from '../controls';

/** `/settings/memory` — the embeddings server behind Qdrant, and post-turn memory distillation. */
export function MemoryPanel() {
  return (
    <div className="animate-fade-up space-y-5">
      <Section title="Embeddings" icon={<Brain size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Vector memory (Qdrant) is backed by a separate embeddings server — not the inference
          endpoints above.
        </p>
        <div className="space-y-4">
          <SettingText
            field="embedding_url"
            label="Embeddings URL"
            hint="OpenAI-compatible base of the --embedding llama.cpp server, e.g. http://embeddings:8080"
          />
          <SettingText
            field="embedding_model"
            label="Embedding model"
            hint="Model name the embeddings server reports."
          />
          <SettingText
            field="embedding_api_key"
            label="API key"
            hint="Usually not required for local llama.cpp."
            password
          />
        </div>
      </Section>

      <Section title="Long-term memory" icon={<Sparkles size={13} />}>
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          After a turn, the agent's own model rewrites what happened into standalone memories — most
          turns produce none. Inspect the result in the Memory Vault.
        </p>
        <div className="space-y-4">
          <SettingToggle
            field="memory_distill_enabled"
            label="Distil memories from turns"
            hint="When on, each completed turn costs one short extra completion, and what it teaches is stored as typed memories (facts, preferences, how-tos, episodes). Off → the agent only remembers what it deliberately saves with the `remember` tool."
          />
          <SettingNumber
            field="memory_max_tokens"
            label="Distiller max tokens"
            hint="Token budget for the distiller's reply. It returns a small JSON object, but a reasoning model still needs room to think before it — keep this ≥512."
            min={128}
          />
        </div>
      </Section>
    </div>
  );
}
