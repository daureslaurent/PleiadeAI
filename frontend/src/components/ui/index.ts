/**
 * The shared on-glass UI kit (DIRECT_ART). Every non-workspace view builds from these; do not
 * hand-roll a card, well, badge, or confirm dialog in a view file.
 */
export { GlassCard, Section, Row, RowGroup, EmptyState, Hint, Callout } from './Glass';
export { Input, Textarea, Select, Label, Field, Toggle, Checkbox, Button, Spinner } from './Controls';
export type { ButtonProps } from './Controls';
export { StatusBadge, Dot, Chip, Pill, toneOf } from './Badge';
export type { Tone } from './Badge';
export { ConfirmProvider, useConfirm } from './Confirm';
export type { ConfirmOptions } from './Confirm';
