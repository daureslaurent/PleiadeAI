# MEDIA_MAPPING_PLAN.md — the Media page, rebuilt around mapping

Companion to `COMFYUI_MEDIA_PLAN.md`. That document explains *why* a ComfyUI workflow has to be
snapshotted and bound before an agent can drive it. This one is about the operator surface for doing
it, because the binding editor shipped there — sixteen rows of `<select node> <select input>` — is
where the whole subsystem goes wrong in practice.

## 1. The actual problem

A binding is a wire between two worlds:

```
  app side                      workflow side
  ────────                      ─────────────
  generate_image (tool)         node 6  CLIPTextEncode.text
  Generate Image (flow node)    node 5  EmptyLatentImage.width
      ↓ prompt/size/seed…       node 3  KSampler.seed
```

The old editor asked the operator to hold that wire in their head. It showed the *app* half as a bare
list of key names, the *workflow* half as two dropdowns with no structure, and the connection between
them nowhere at all. The graph's own shape — which node feeds which — was invisible, so "is node 42
the positive encoder or the negative one?" had no answer on the page. And nothing said which tools or
flow nodes actually *run* this workflow, so a mis-bound graph was only discovered by an agent
producing the workflow author's prompt ten minutes later.

## 2. What replaces it

The Media page becomes a master–detail workbench (`MasterDetail`, as Agents/Skills/Isolations use):

- **Rail** — every imported workflow as a card: kind icon, name, node count, average runtime, a
  bound/unbound meter, and its enabled toggle. Filter by kind, search by name.
- **Detail** — a header (name, kind, description, models, validation state, enable/delete) over two
  tabs: **Mapping** and **Run**.
- **Add** — one panel with two routes in: *Discover* (cards from ComfyUI's `/history`, as today) and
  *Paste API JSON* (drop a `workflow_api.json` file or paste it). Import no longer requires a
  reachable ComfyUI: without one the graph is stored and auto-bound with empty schemas, and validate
  fills in the constraints later.

### The mapping canvas

The Mapping tab is a React Flow canvas — the same vocabulary as the Flows page, deliberately, since
it is the same act (wiring ports together) and the operator already knows it.

```
 ┌──────────────┐        ┌───────────────┐     ┌──────────────┐      ┌──────────────┐
 │ App inputs   │───────▶│ CLIPTextEncode│────▶│ KSampler     │─────▶│ App output   │
 │ prompt     ○─┼──┐     │ ○ text        │     │ ○ seed       │      │ ●─ image     │
 │ seed       ○─┼──┼────▶│ ○ clip        │     │ ○ steps      │      └──────────────┘
 │ width      ○─┼─┐└────▶└───────────────┘     └──────────────┘
 └──────────────┘ │
```

- **App inputs** node — one output port per logical parameter (`prompt`, `seed`, `width`, `image1`…),
  coloured by the Flows port palette and carrying the same names the tool/flow config uses. This is
  the half that was previously text-only.
- **Workflow nodes** — one card per graph node, auto-laid out in topological columns. Widget inputs
  are target handles; linked inputs are shown but dimmed. The graph's own links are drawn as faint
  edges, so the shape of the workflow is finally visible.
- **App output** node — the workflow's result node wires into it, which is how `output_node_id` and
  `output_kind` get set.
- **A binding is an edge.** Drag app port → node input to bind; click the × on an edge to unbind.
  Everything the old dropdown grid did, plus the context it was missing.

Supporting panes: a legend + unbound-parameter strip under the canvas, and an inspector for the
selected node listing every input with its current literal, its declared spec (min/max/step/enum) and
a one-click bind menu — the dropdown path stays available, it is just no longer the only path.

### Consumers

The detail header answers "who uses this": every media **tool** whose config selects this workflow and
every **flow node** across every saved flow that selects it. That is the link between the Media page
and the Tools/Flows pages that did not exist, and it is what makes a bad binding traceable to the
thing that will run it.

## 3. Backend changes

| Change | File | Why |
|---|---|---|
| `describeNodes` also reports each node's **outputs**, each input's **link source**, and whether it is bindable | `media/comfy/graph-introspect.ts` | the canvas draws the graph, not just a node list |
| `relevantKeys('video_edit')` | same | it fell through to the image keys, so a video-edit workflow reported nonsense unbound parameters |
| `BINDING_META` catalog (label, port type, value type, description, which kinds care) | `domain/media-workflows/binding-meta.ts` | the app-side ports render themselves from the backend, as the flows node registry does |
| `GET /api/media/binding-keys` | `transport/http/routes/media.routes.ts` | serves that catalog |
| detail route returns `models`, `graph_hash`, `notes`, `consumers` | same | header content + the tools/flows link |
| `POST /api/media/workflows/:id/autobind` | same | re-run the auto-binder on demand; returns a *proposal*, the operator saves it |
| paste-import degrades without ComfyUI; the pasted JSON is unwrapped (bare graph, `{prompt:…}`, or a named error for the editor format) | same | you can add a workflow before the server is up |
| `hydrateBindings` on save: re-derive each binding's `spec`/`overrides_link` from the graph, drop ones pointing at a node that no longer exists | `graph-introspect.ts` + PUT route | **the editor only knows `{node_id, input}`**, and the old page saved exactly that — so every hand-corrected binding lost its schema snapshot and `clampToSpec` stopped snapping `length` onto the model's frame grid |
| repointing `output_node_id` re-derives `output_kind` | PUT route | otherwise moving a graph's result to its `SaveVideo` left `output_kind: image` and the run picked the wrong artifact |
| `describeNodes` synthesises output slots from the links that consume them, and infers an input's type from its literal when no schema is available | `graph-introspect.ts` | with ComfyUI down every input read as `LINK` (nothing bindable) and no node had outputs (no wiring drawn) — the canvas was blank exactly when it was least checkable against ComfyUI itself |

No schema migration: `bindings`, `output_node_id` and `output_kind` already exist and keep their
shape. Only the editor changes.

## 4. Frontend layout

```
frontend/src/views/media/
  MediaView.tsx        master-detail shell, status pill, add-panel toggle
  WorkflowRail.tsx     the library rail (search, kind filter, cards)
  WorkflowDetail.tsx   header + Mapping/Run tabs
  MappingCanvas.tsx    React Flow canvas, layout, edges, drag-to-bind
  MappingNodes.tsx     the three card types (app-in, comfy node, app-out)
  MappingInspector.tsx selected node's inputs + bind menu; the whole mapping when nothing is selected
  ImportPanel.tsx      discovery cards + paste/drop API JSON
  bindingPorts.ts      binding key → port colour/type helpers
```

Art direction (`DIRECT_ART.md`): glass rail, `bg-black/25` in-flow cards, white-alpha hairlines,
port colours from `views/flows/portStyle.ts` (same palette, same meaning), `animate-fade-up`
entrances, motion only on live things (the test run, a validating button).
