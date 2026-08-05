import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export interface FlowEdgeData extends Record<string, unknown> {
  color: string;
  /** Absent in read-only mode (a run replay), which is what hides the delete affordance. */
  onDelete?: (id: string) => void;
}

/**
 * A link, with a delete button that appears on hover or selection.
 *
 * React Flow's own affordance is "select the edge, press Backspace", which is invisible until
 * someone tells you about it — and on a canvas whose whole point is wiring, unwiring has to be as
 * discoverable as wiring. The × sits at the midpoint, and the hit area is widened by
 * `interactionWidth` so a 1.6px line is actually clickable.
 */
export const FlowEdgeLine = memo(function FlowEdgeLine({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
  style,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  });

  const edgeData = data as FlowEdgeData | undefined;
  const color = edgeData?.color ?? '#64748b';
  const active = Boolean(selected) || hovered;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={18}
        style={{ ...style, stroke: color, strokeWidth: active ? 2.6 : 1.6 }}
      />
      <EdgeLabelRenderer>
        {/* `pointer-events: all` because the label layer is inert by default; `nodrag`/`nopan` keep a
            click on the button from panning the canvas underneath it. */}
        <div
          className="nodrag nopan absolute"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {edgeData?.onDelete && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                edgeData.onDelete?.(id);
              }}
              title="Delete link"
              aria-label="Delete link"
              className={`flex h-4 w-4 items-center justify-center rounded-full border text-[10px] leading-none transition-all ${
                active
                  ? 'scale-100 border-red-400/60 bg-[#0d1424] text-red-400 opacity-100 hover:bg-red-500/20'
                  : 'scale-75 border-transparent bg-transparent text-transparent opacity-0'
              }`}
            >
              ×
            </button>
          )}
          {/* An invisible pad keeps hover alive in the gap around the tiny button, so the × doesn't
              flicker out the moment the pointer moves a few pixels. */}
          <div className="absolute -inset-2 -z-10" />
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
