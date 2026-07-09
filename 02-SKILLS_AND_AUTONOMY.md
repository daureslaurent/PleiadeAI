# PleiadesAI: OpenCode Skills, Autonomy & Resilience Protocols

## 1. Multimodal Input Processing
Agents can analyze images via the backend's proxy to `llama.cpp` (running a VLM).
- **Direct Input:** The frontend converts drag-and-drop images to Base64 and sends them in the `image_url` block.
- **Tool-Acquired Input:** If a skill (e.g., `take_screenshot`) returns a Base64 image payload, the JIT builder appends it to the context window, allowing the agent to analyze the generated visual automatically.

## 2. Local Parameter Store & Mutation Tool
Every agent possesses automated visibility and mutation capabilities over its local parameter configuration:
1. **JIT Prompt Injection:** During assembly, the backend injects the MongoDB `parameters` map as a Markdown block at the top of the system prompt.
2. **The Mutation Tool (`set_agent_parameter`):** A core tool provisioned to all agents. Executing `set_agent_parameter(key: string, value: string)` updates the database document in real-time, permanently saving the KV pair for all future sessions.

## 3. The Dynamic Skill Environment & Reliability Engine
Skills are modular TypeScript or Python scripts stored dynamically in MongoDB.
*   **Sandbox Limitation:** All skills execute strictly inside the isolated bounds of the `pleiades_backend` Docker container. Any external OS interaction must occur via network APIs or standard SSH loopbacks defined in parameters.
*   **Execution Isolation:** TypeScript runs via native child worker threads. Python executes via spawned isolated sub-processes passing data over clean JSON streams.
*   **Execution Auditing:** Sandbox spin-ups, `stdout`/`stderr` streams, and exit codes are piped to the Pino logger.
*   **Skill Execution Boundaries & Circuit Breakers:** Sandboxes have a hard timeout (e.g., 15s). If a skill hangs or crashes three consecutive times, the backend trips a circuit breaker, marking it as `disabled` in MongoDB and throwing an error to the EventBus.

## 4. Multi-Agent Recursion Guard
When agents communicate via the `ask_agent` tool:
*   **Hop Limit:** The system enforces a hard limit of **3 agent-to-agent hops**. Exceeding this depth breaks the circuit and returns a structural error to prevent token exhaustion.
*   **UI Transparency:** The frontend treats these hops as full sub-chat panels, displaying the internal multi-agent conversation in real-time.

## 5. Autonomous Cron Scheduling & Conflict Architecture
Autonomous cron tasks are powered by **Agenda**.
*   **Concurrency Lock:** If a cron job fires while a user is actively communicating with that exact agent in the UI, the user chat takes absolute priority. The background task queues and waits until the active session naturally resolves.
*   **Dual Alert Pipeline:** When a headless task completes and triggers an alert, the backend pushes it simultaneously to:
    1. A persistent `notifications` document in MongoDB (UI Inbox).
    2. An external Telegram Bot webhook API.