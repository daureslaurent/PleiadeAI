// Conversation Generator (docs/conversation-generator.md): an interviewer agent chats up selected
// agents on a schedule, harvesting multi-turn conversations for future SFT training.
//
//   sessions.origin        — new: 'user' (the operator's own chats) | 'synthetic' (generated).
//   sessions.generator_id  — new: the `conversation_generators` row that produced a synthetic session.
//   agents/Interviewer     — seeded: the default interviewer. `subagent: false` keeps it out of the
//                            annuaire so no agent can delegate to it; it holds no tools because it
//                            runs as a plain inference call, never through the tool loop.
//
// The `conversation_generators` collection itself is created lazily by Mongoose; only its unique
// index (one generator per target agent) is declared here.

const INTERVIEWER_NAME = 'Interviewer';

const INTERVIEWER_PROMPT = [
  'You are an interviewer. You talk to AI agents to draw out the best, most revealing conversations',
  'they are capable of — the transcripts become training data, so the quality of what the agent says',
  'depends on the quality of what you ask.',
  '',
  'How you work:',
  '- Speak as a real user of the agent would: concrete, situated, with a genuine need. Never as a',
  '  quizmaster, an evaluator, or an AI addressing another AI.',
  '- Open with a real request that lands squarely in the agent\'s stated purpose. Give it enough',
  '  context to act on — a made-up but plausible situation, with specifics.',
  '- Then actually read its reply, and follow up like someone who cares about the answer: push on the',
  '  vague part, add a constraint, change your mind, report that its suggestion did not work, or ask',
  '  it to go deeper on the interesting thread. Never ignore what it just said.',
  '- Ask things that make the agent *work*: use its tools, reason through trade-offs, admit what it',
  '  cannot do. Avoid trivia it can answer in one line.',
  '- Vary yourself across conversations — tone, expertise level, phrasing, how much you give away.',
  '  Repetitive interviews make a repetitive dataset.',
  '',
  'Write only your next message to the agent. No labels, no quotes, no commentary about the exercise.',
].join('\n');

module.exports = {
  async up(db) {
    const sessions = db.collection('sessions');
    // Every pre-existing session is one the operator had themselves.
    await sessions.updateMany({ origin: { $exists: false } }, { $set: { origin: 'user', generator_id: null } });
    await sessions.createIndex({ origin: 1 });
    await sessions.createIndex({ generator_id: 1 });

    await db.collection('conversation_generators').createIndex({ target_agent_id: 1 }, { unique: true });

    // Seed the default interviewer, unless the operator already has an agent by that name.
    const agents = db.collection('agents');
    const existing = await agents.findOne({ name: INTERVIEWER_NAME });
    if (!existing) {
      const now = new Date();
      await agents.insertOne({
        name: INTERVIEWER_NAME,
        description: 'Interviews other agents to generate conversations for training data.',
        subagent: false,
        system_prompt: INTERVIEWER_PROMPT,
        tools_allowed: [],
        qdrant_namespace: 'interviewer',
        parameters: {},
        agents_md: '',
        notebook: '',
        isolation_id: null,
        isolation_volume_mode: 'individual',
        endpoint_id: null,
        model: '',
        max_tool_iterations: null,
        color: null,
        icon: '',
        created_at: now,
        updated_at: now,
      });
    }
  },

  async down(db) {
    const sessions = db.collection('sessions');
    // Generated sessions only exist because of this feature — remove them and their messages.
    const synthetic = await sessions.find({ origin: 'synthetic' }, { projection: { _id: 1 } }).toArray();
    if (synthetic.length) {
      const ids = synthetic.map((s) => s._id);
      await db.collection('messages').deleteMany({ session_id: { $in: ids } });
      await sessions.deleteMany({ _id: { $in: ids } });
    }
    await sessions.updateMany({}, { $unset: { origin: '', generator_id: '' } });

    await db.collection('conversation_generators').drop().catch(() => undefined);
    await db.collection('agents').deleteOne({ name: INTERVIEWER_NAME, qdrant_namespace: 'interviewer' });
  },
};
