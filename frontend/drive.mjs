import { io } from 'socket.io-client';
const token = process.argv[2];
const prompt = process.argv[3] || "Quelles sont les toutes dernières news sur Star Citizen 4.9 ? Va chercher sur le web.";
const socket = io('http://localhost:4000', { auth: { token }, transports: ['websocket'] });
let done = false;
const finish = (why) => { if(done) return; done=true; console.log('\n=== END ('+why+') ==='); socket.close(); process.exit(0); };
socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('chat:message', { agentName: 'Nova', content: prompt });
});
socket.on('connect_error', e => { console.log('connect_error', e.message); process.exit(1); });
socket.onAny((ev, payload) => {
  // Print concise view of interesting events
  if (ev === 'chat:done') { console.log('[chat:done]', JSON.stringify(payload).slice(0,200)); finish('chat:done'); }
  else if (ev === 'agent:ask_agent' || ev.includes('ask_agent')) console.log('['+ev+']', JSON.stringify(payload).slice(0,200));
  else if (ev === 'tool:invoke' || ev === 'agent:tool_invoke') console.log('['+ev+']', JSON.stringify(payload).slice(0,160));
  else if (ev === 'system_alert') console.log('[system_alert]', JSON.stringify(payload).slice(0,200));
});
setTimeout(()=>finish('timeout'), 240000);
