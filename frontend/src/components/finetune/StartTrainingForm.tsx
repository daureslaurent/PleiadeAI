import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ChevronDown, Loader2, Play, Upload } from 'lucide-react';
import {
  finetuneServersApi,
  type Feasibility,
  type FinetuneServer,
  type HardwareReport,
  type ScoreTag,
  type StartTrainBody,
  type TrainingPlan,
} from '../../lib/api';

/**
 * Launch a training run.
 *
 * The base model is a free-text HuggingFace id (the server accepts any). We derive its size from a
 * `<n>B` token in the name — or take the operator's `target_size_b` override — and match it against
 * the selected server's feasibility table to show a **live fit hint before submitting**. The server
 * remains the authority: its returned `plan` (with any auto-adjustments) is what we display after.
 */
const FIT_STYLE: Record<Feasibility, { box: string; text: string }> = {
  ok: { box: 'border-emerald-500/20 bg-emerald-500/[0.07]', text: 'text-emerald-300' },
  tight: { box: 'border-amber-500/20 bg-amber-500/[0.07]', text: 'text-amber-300' },
  no: { box: 'border-red-500/20 bg-red-500/[0.07]', text: 'text-red-300' },
};

/** Same heuristic the server uses: largest `<n>B` token in the model id. */
function parseSizeFromName(name: string): number | null {
  const matches = [...name.matchAll(/(\d+(?:\.\d+)?)\s*[bB](?![a-zA-Z])/g)];
  const values = matches.map((m) => Number(m[1])).filter((v) => v > 0 && v < 2000);
  return values.length ? Math.max(...values) : null;
}

/** Nearest table row at or above the requested size — the honest bound for a fit hint. */
function fitFor(hardware: HardwareReport | null, sizeB: number | null) {
  if (!hardware || sizeB == null) return null;
  const sorted = [...hardware.sizes].sort((a, b) => a.size_b - b.size_b);
  return sorted.find((s) => s.size_b >= sizeB) ?? sorted[sorted.length - 1] ?? null;
}

export function StartTrainingForm({
  servers,
  minScore,
  tags,
  filteredCount,
  onStarted,
}: {
  servers: FinetuneServer[];
  minScore: number;
  tags: ScoreTag[];
  filteredCount: number;
  onStarted: () => void;
}) {
  const [serverId, setServerId] = useState('');
  const [baseModel, setBaseModel] = useState('');
  const [runName, setRunName] = useState('');
  const [targetSizeB, setTargetSizeB] = useState('');
  const [onInfeasible, setOnInfeasible] = useState<'auto_adjust' | 'warn_proceed'>('auto_adjust');
  const [source, setSource] = useState<'scored' | 'manual'>('scored');
  const [file, setFile] = useState<File | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [epochs, setEpochs] = useState('');
  const [seqLen, setSeqLen] = useState('');
  const [lr, setLr] = useState('');
  const [quant, setQuant] = useState('');

  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!serverId && servers[0]) setServerId(servers[0]._id);
  }, [servers, serverId]);

  // Pull the selected server's capability table so we can hint fit before submitting.
  useEffect(() => {
    if (!serverId) return;
    let alive = true;
    finetuneServersApi
      .hardware(serverId)
      .then((h) => alive && setHardware(h))
      .catch(() => alive && setHardware(null));
    return () => {
      alive = false;
    };
  }, [serverId]);

  const effectiveSize = useMemo(() => {
    const override = Number(targetSizeB);
    if (targetSizeB && Number.isFinite(override) && override > 0) return override;
    return parseSizeFromName(baseModel);
  }, [targetSizeB, baseModel]);

  const hint = fitFor(hardware, effectiveSize);

  const canSubmit =
    !!serverId && baseModel.trim() && runName.trim() && !busy &&
    (source === 'manual' ? !!file : filteredCount > 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setPlan(null);
    try {
      let dataset: StartTrainBody['dataset'];
      if (source === 'manual') {
        if (!file) throw new Error('choose a .jsonl file');
        const uploaded = await finetuneServersApi.upload(serverId, file);
        dataset = { source: 'manual', dataset_id: uploaded.dataset_id };
      } else {
        dataset = { source: 'scored', filter: { minScore, tags: tags.length ? tags : undefined } };
      }

      const hyperparams: Record<string, number | string> = {};
      if (epochs) hyperparams.num_epochs = Number(epochs);
      if (seqLen) hyperparams.sequence_len = Number(seqLen);
      if (lr) hyperparams.learning_rate = Number(lr);
      if (quant) hyperparams.gguf_quant = quant;

      const res = await finetuneServersApi.train(serverId, {
        run_name: runName.trim(),
        base_model: baseModel.trim(),
        target_size_b: effectiveSize ?? undefined,
        on_infeasible: onInfeasible,
        ...(Object.keys(hyperparams).length ? { hyperparams } : {}),
        dataset,
      });
      setPlan(res.plan);
      onStarted();
    } catch (err) {
      const detail =
        (err as { response?: { data?: { detail?: string; error?: string } } }).response?.data;
      setError(detail?.detail ?? detail?.error ?? (err instanceof Error ? err.message : 'failed'));
    } finally {
      setBusy(false);
    }
  };

  if (servers.length === 0) {
    return (
      <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-5 text-sm text-slate-500">
        No fine-tune servers configured. Add one in <span className="text-slate-300">Settings</span>.
      </section>
    );
  }

  return (
    <section className="glass-card animate-fade-up rounded-2xl border border-white/[0.06] p-5">
      <header className="mb-4">
        <h2 className="text-sm font-semibold text-slate-100">Start a fine-tune</h2>
        <p className="text-xs text-slate-500">
          The server checks feasibility and may adjust settings to fit its GPUs.
        </p>
      </header>

      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Server">
          <select
            value={serverId}
            onChange={(e) => setServerId(e.target.value)}
            className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-accent/40"
          >
            {servers.map((s) => (
              <option key={s._id} value={s._id} className="bg-panel">
                {s.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Run name">
          <TextIn value={runName} onChange={setRunName} placeholder="support-agent-v3" />
        </Field>

        <Field label="Base model (HuggingFace id)">
          <TextIn value={baseModel} onChange={setBaseModel} placeholder="Qwen/Qwen2.5-14B-Instruct" mono />
        </Field>

        <Field label="Target size (B) — optional override">
          <TextIn
            value={targetSizeB}
            onChange={setTargetSizeB}
            placeholder={effectiveSize ? `auto: ${effectiveSize}` : 'e.g. 9 or 24'}
            mono
          />
        </Field>
      </div>

      {/* Live feasibility hint (pre-submit; the server's plan is authoritative). */}
      {hint && effectiveSize != null && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-[11px] ${FIT_STYLE[hint.feasibility].box}`}>
          <span className={`font-medium ${FIT_STYLE[hint.feasibility].text}`}>
            {effectiveSize}B → {hint.feasibility}
          </span>
          <span className="ml-2 text-slate-400">{hint.note}</span>
        </div>
      )}

      {/* Dataset source */}
      <div className="mt-4 border-t border-white/[0.06] pt-4">
        <div className="mb-2.5 flex items-center gap-1.5">
          <span className="mr-1 text-[10px] uppercase tracking-wider text-slate-500">Dataset</span>
          <Seg active={source === 'scored'} onClick={() => setSource('scored')}>
            Scored export
          </Seg>
          <Seg active={source === 'manual'} onClick={() => setSource('manual')}>
            Upload .jsonl
          </Seg>
        </div>

        {source === 'scored' ? (
          <p className="text-[11px] text-slate-500">
            Uses the current quality filter above —{' '}
            <span className="font-mono text-slate-300">{filteredCount.toLocaleString()}</span> examples.
            {filteredCount === 0 && (
              <span className="ml-1.5 text-amber-300">Nothing matches; loosen the filter.</span>
            )}
          </p>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/[0.07] bg-black/30 px-3 py-1.5 text-[11px] text-slate-300 transition-colors hover:bg-white/[0.05]">
            <Upload size={12} />
            {file ? <span className="font-mono">{file.name}</span> : 'Choose a .jsonl file'}
            <input
              type="file"
              accept=".jsonl,application/x-ndjson"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
        )}
      </div>

      {/* Advanced */}
      <div className="mt-4 border-t border-white/[0.06] pt-3">
        <button
          onClick={() => setShowAdvanced((v) => !v)}
          className="flex items-center gap-1.5 text-[11px] text-slate-500 transition-colors hover:text-slate-300"
        >
          <ChevronDown size={12} className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
          Advanced
        </button>
        {showAdvanced && (
          <div className="mt-3 grid gap-3 md:grid-cols-4">
            <Field label="Epochs">
              <TextIn value={epochs} onChange={setEpochs} placeholder="3" mono />
            </Field>
            <Field label="Sequence len">
              <TextIn value={seqLen} onChange={setSeqLen} placeholder="2048" mono />
            </Field>
            <Field label="Learning rate">
              <TextIn value={lr} onChange={setLr} placeholder="0.0002" mono />
            </Field>
            <Field label="GGUF quant">
              <TextIn value={quant} onChange={setQuant} placeholder="q4_k_m" mono />
            </Field>
            <Field label="If it doesn't fit">
              <select
                value={onInfeasible}
                onChange={(e) => setOnInfeasible(e.target.value as 'auto_adjust' | 'warn_proceed')}
                className="w-full rounded-lg border border-white/[0.07] bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 outline-none focus:border-accent/40"
              >
                <option value="auto_adjust" className="bg-panel">
                  Auto-adjust, else reject
                </option>
                <option value="warn_proceed" className="bg-panel">
                  Warn but proceed
                </option>
              </select>
            </Field>
          </div>
        )}
      </div>

      {/* Result: the server's recommendation */}
      {plan && <PlanCard plan={plan} />}

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.07] px-3 py-2 text-[11px] text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 flex justify-end">
        <button
          onClick={() => void submit()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-lg bg-accent/20 px-3.5 py-2 text-xs font-medium text-accent ring-1 ring-accent/40 transition hover:bg-accent/30 active:scale-95 disabled:opacity-40"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
          Start training
        </button>
      </div>
    </section>
  );
}

/** The server's fitted plan — its recommendation, including anything it changed to make it fit. */
function PlanCard({ plan }: { plan: TrainingPlan }) {
  const style = FIT_STYLE[plan.feasibility];
  return (
    <div className={`mt-4 rounded-xl border p-3 ${style.box}`}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className={`font-medium uppercase tracking-wider ${style.text}`}>{plan.feasibility}</span>
        <span className="font-mono text-slate-300">{plan.size_b}B</span>
        <span className="text-slate-500">
          {plan.strategy === 'fsdp_qlora' ? 'FSDP+QLoRA' : 'ZeRO-2 QLoRA'}
        </span>
        <span className="font-mono text-slate-500">seq {plan.sequence_len}</span>
        <span className="ml-auto font-mono text-slate-400">
          ~{plan.est_per_gpu_vram_gb}/{plan.usable_per_gpu_vram_gb} GB per GPU
        </span>
      </div>
      {plan.adjustments.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-slate-400">
          {plan.adjustments.map((a) => (
            <li key={a}>• {a}</li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-amber-300/90">
          {plan.warnings.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function TextIn({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-lg border border-white/[0.07] bg-black/30 px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-600 outline-none focus:border-accent/40 ${
        mono ? 'font-mono' : ''
      }`}
    />
  );
}

function Seg({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${
        active ? 'bg-accent/15 text-accent ring-1 ring-accent/30' : 'text-slate-500 hover:bg-white/[0.05]'
      }`}
    >
      {children}
    </button>
  );
}
