import { stringify } from 'yaml';
import path from 'node:path';
import type { HyperParams, TrainingPlan } from '../types';
import { env } from '../config/env';

/**
 * Build the Axolotl `config.yml` for one run.
 *
 * Fixed choices (see plan §Decisions):
 *  - 4-bit QLoRA (`load_in_4bit` + `adapter: qlora`, nf4) to fit a 13–14B base on 16GB/GPU.
 *  - Multi-GPU via DeepSpeed ZeRO-2 (shards optimizer+gradients only; ZeRO-3 is incompatible
 *    with bitsandbytes 4-bit weights).
 *  - Dataset type `chat_template` reading the OpenAI-style `messages` field — exactly the shape
 *    the main app's `scoring/export.service.ts` emits.
 *
 * Every numeric default is conservative for 13–14B on 16GB/GPU and overridable per-run.
 */
export interface AxolotlConfigArgs {
  baseModel: string;
  datasetPath: string;
  outputDir: string;
  hyperparams: HyperParams;
  /** Hardware-fitted plan: sets the multi-GPU strategy + resolved seq_len/batch. */
  plan: TrainingPlan;
}

/** DeepSpeed ZeRO-2 vs FSDP+QLoRA config fragment, chosen from the plan's strategy. */
function strategyConfig(plan: TrainingPlan): Record<string, unknown> {
  if (plan.strategy === 'fsdp_qlora') {
    // FSDP shards the base across GPUs so models too big for one GPU still train.
    // We rely on transformers' `_no_split_modules` for auto-wrap rather than hardcoding
    // the decoder layer class, so this stays model-agnostic (see plan Risk note).
    return {
      fsdp: ['full_shard', 'auto_wrap'],
      fsdp_config: {
        fsdp_limit_all_gathers: true,
        fsdp_sync_module_states: true,
        fsdp_offload_params: false,
        fsdp_use_orig_params: false,
        fsdp_cpu_ram_efficient_loading: true,
        fsdp_auto_wrap_policy: 'TRANSFORMER_BASED_WRAP',
        fsdp_state_dict_type: 'FULL_STATE_DICT',
        fsdp_sharding_strategy: 'FULL_SHARD',
      },
    };
  }
  return { deepspeed: env.DEEPSPEED_CONFIG };
}

export function buildAxolotlConfig(args: AxolotlConfigArgs): string {
  const hp = args.hyperparams;
  const plan = args.plan;

  const config = {
    base_model: args.baseModel,
    // Let Axolotl pick the right loader classes for the base model.
    trust_remote_code: false,

    // --- 4-bit QLoRA ---
    load_in_4bit: true,
    load_in_8bit: false,
    adapter: 'qlora',
    bnb_4bit_quant_type: 'nf4',
    bnb_4bit_compute_dtype: 'bfloat16',
    bnb_4bit_use_double_quant: true,

    lora_r: hp.lora_r ?? 16,
    lora_alpha: hp.lora_alpha ?? 32,
    lora_dropout: hp.lora_dropout ?? 0.05,
    lora_target_linear: true,

    // --- Dataset (OpenAI chat `{messages}` per line) ---
    datasets: [
      {
        path: args.datasetPath,
        ds_type: 'json',
        type: 'chat_template',
        field_messages: 'messages',
        message_property_mappings: {
          role: 'role',
          content: 'content',
        },
        roles: {
          user: ['user'],
          assistant: ['assistant'],
          system: ['system'],
          tool: ['tool'],
        },
      },
    ],
    chat_template: 'tokenizer_default',
    // Train only on assistant responses, not the prompt tokens.
    train_on_inputs: false,

    // --- Sequencing / batching (resolved by the capacity planner to fit the hardware) ---
    sequence_len: plan.sequence_len,
    sample_packing: true,
    pad_to_sequence_len: true,
    micro_batch_size: plan.micro_batch_size,
    gradient_accumulation_steps: plan.gradient_accumulation_steps,

    // --- Optimization ---
    num_epochs: hp.num_epochs ?? 3,
    optimizer: 'adamw_bnb_8bit',
    learning_rate: hp.learning_rate ?? 0.0002,
    lr_scheduler: 'cosine',
    warmup_ratio: hp.warmup_ratio ?? 0.03,
    weight_decay: 0.0,

    // --- Memory / precision ---
    bf16: true,
    fp16: false,
    tf32: false,
    gradient_checkpointing: true,
    flash_attention: true,

    // --- Multi-GPU strategy (ZeRO-2 by default; FSDP for base-sharding large models) ---
    ...strategyConfig(plan),

    // --- Output / checkpointing ---
    output_dir: args.outputDir,
    save_steps: hp.save_steps ?? 100,
    save_total_limit: 2,
    logging_steps: 5,
    // Fold the LoRA adapter into the base weights on completion so a single merged
    // model dir is ready for GGUF conversion.
    save_safetensors: true,
  };

  return stringify(config);
}

/** Convenience: the merged-model directory Axolotl writes under `output_dir`. */
export function mergedModelDir(outputDir: string): string {
  return path.join(outputDir, 'merged');
}
