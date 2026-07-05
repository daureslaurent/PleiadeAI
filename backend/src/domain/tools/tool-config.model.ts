import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `tool_configs` collection — one document per configurable core tool (keyed by tool `name`).
 * Holds the operator-tuned option values set from the Tools page plus a master enable switch.
 * `config` is a free-form object because each tool declares its own option schema in code; the
 * effective values are resolved by merging this over the schema defaults (see tool-config.service).
 */
const ToolConfigSchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    enabled: { type: Boolean, default: true },
    config: { type: Schema.Types.Mixed, default: () => ({}) },
  },
  { collection: 'tool_configs', timestamps: { createdAt: false, updatedAt: 'updated_at' } },
);

export type ToolConfig = InferSchemaType<typeof ToolConfigSchema>;
export type ToolConfigDoc = HydratedDocument<ToolConfig>;

export const ToolConfigModel = model('ToolConfig', ToolConfigSchema);
