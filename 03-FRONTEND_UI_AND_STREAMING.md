# PleiadeAI: Frontend Command Center & WebSockets

## 1. Developer Interface Design
The frontend uses Next.js or Vite with Tailwind CSS and `shadcn/ui`, built into an optimized production Nginx container. It uses a high-density, wide-layout dark mode designed for clear data parsing.

**Required Views:**
1.  **Authentication Guard:** A secure lock screen validating JWT tokens. Session storage checks validation on client routing changes.
2.  **Agent Workspace (Chat & Debugger):** Features a standard chat panel alongside an expandable split-pane. This drawer acts as a live debugger, showing the exact tool calls, sandbox timeouts, circuit breaker states, cross-agent hop traces, and internal reasoning (`<think>`) blocks as they happen in real-time. Supports drag-and-drop image uploads for multimodal queries.
3.  **Skill & Agent Matrix:** CRUD panel managing the MongoDB configurations. Features an integrated Monaco Editor allowing you to write, check, and edit raw TypeScript or Python skill code before saving it to the database.
4.  **Memory Vault:** Fully segregated inspector layout. Allows you to choose an agent, inspect their isolated Qdrant vector block, and explicitly delete corrupted or hallucinated memory records.
5.  **Autonomy & Inbox Monitor:** A control board listing upcoming Agenda tasks alongside the unread `notifications` inbox collected from background cron routines. Includes a global execution kill switch.

## 2. WebSocket Protocol Schema
Streams pass through a real-time WebSocket connection to allow instant UI switches. While Pino handles persistent logging on the backend, the frontend relies entirely on this schema for real-time visualization.

```json
// Token streaming (Standard text or internal reasoning blocks)
{ "type": "stream_chunk", "agent": "devops_agent", "content": "Analyzing logs...", "is_reasoning": false }

// Sub-Agent invocation trace (Shows the user what's happening background-level)
{ "type": "agent_hop", "from": "devops_agent", "to": "home_coordinator", "depth": 1, "query": "Get room temperature" }

// Tool/Skill execution start state
{ "type": "tool_start", "agent": "devops_agent", "tool": "run_python_script" }

// Execution conclusion
{ "type": "tool_end", "agent": "devops_agent", "status": "success", "result": "0 errors found" }

// Sandbox / Inference Recovery Event Notification
{ "type": "system_alert", "level": "error", "message": "Circuit breaker tripped for skill: run_python_script" }