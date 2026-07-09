# Desktop Operator agent template

A top-level agent that controls a Linux (MATE) desktop through the visual tools
(`visual_screenshot`, `visual_act`, `visual_windows`) plus `bash`.

## Files
- **`SYSTEM_PROMPT.md`** → paste into the agent's **System prompt** field (Agents page).
- **`AGENTS.md`** → paste into the agent's **Agents.md** notebook field (the agent can later edit it via `update_agents_md`).

## Create the agent (Agents page)
1. **New agent**, name it e.g. `desktop-operator`. Leave it a **top-level** agent (subagent = off) so you can chat with it directly.
2. Paste `SYSTEM_PROMPT.md` into **System prompt** and `AGENTS.md` into **Agents.md**.
3. **Model:** assign a strong text/reasoning model. It does **not** need to be multimodal — vision is handled separately (see below).
4. Leave `tools_allowed` as-is: the `visual_*` tools are **auto-granted** because the agent's image is visual (see next step).

## Prerequisites for it to actually work
- **Isolation profile → visual image.** Assign the agent an isolation profile whose image has the **Visual desktop** toggle on (the Xvfb + x11vnc + MATE image). Without it, the `visual_*` tools return an isolation error.
  - MATE users: the boot script auto-detects `mate-session`/`marco`; force it with `ENV PLEIADES_VISUAL_WM=marco` in the image Dockerfile if needed.
- **Vision endpoint.** In **Settings → Vision endpoint**, select an endpoint whose model supports vision (llama.cpp launched with `--mmproj`, e.g. Qwen2.5‑VL). `visual_screenshot` sends the screenshot there for analysis; without it, screenshots can't be interpreted.

## Watch / take over
Open the agent's **Desktop** panel (or "Open in window") to watch it work live; **Take control** to drive manually — the agent's `visual_act` pauses while you hold control.
