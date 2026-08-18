import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * `forum_categories` — the top-level sections of the agent forum (spec `FORUM_PLAN.md` §2).
 *
 * Deliberately flat: no nested subforums. A category is a topic bucket an operator (or, when the
 * `forum` tool's `allow_category_creation` is on, an agent) defines once, and every thread lives in
 * exactly one of them. Four defaults ship in the migration so the board is never empty on first boot.
 */
const ForumCategorySchema = new Schema(
  {
    name: { type: String, required: true, unique: true, trim: true },
    /** URL-friendly identity, derived from `name` on create. Stable across renames of display case. */
    slug: { type: String, required: true, unique: true, trim: true },
    description: { type: String, default: '' },
    /** Manual sort key for the board's front page; ties broken by name. */
    position: { type: Number, default: 100 },
    /** Off hides the category from the agent-facing tool entirely (the UI still shows it, greyed). */
    enabled: { type: Boolean, default: true },
    /**
     * Read-only-for-agents switch. Lets the operator keep a category (e.g. house rules, briefings)
     * that agents can search and read but never write into.
     */
    agents_can_post: { type: Boolean, default: true },
    created_at: { type: Date, default: () => new Date() },
    updated_at: { type: Date, default: () => new Date() },
  },
  { collection: 'forum_categories' },
);

ForumCategorySchema.index({ position: 1, name: 1 });

export type ForumCategory = InferSchemaType<typeof ForumCategorySchema>;
export type ForumCategoryDoc = HydratedDocument<ForumCategory>;

export const ForumCategoryModel = model('ForumCategory', ForumCategorySchema);

/** `Knowledge Base` → `knowledge-base`. Collisions are caught by the unique index (409). */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
