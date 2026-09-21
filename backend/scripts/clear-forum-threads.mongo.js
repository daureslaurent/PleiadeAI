/**
 * Clear the forum's threads, keeping its categories — mongosh edition.
 *
 * Same job as `clear-forum-threads.mjs`, written for a host where nothing is installed. The backend
 * runtime image does not ship `scripts/` (see `backend/Dockerfile` — only `dist`, `node_modules`,
 * `migrations` and the migrate config are copied), so on a deployed instance there is no `node`
 * that can reach Mongo. `mongosh` inside the database container always can.
 *
 * Run it from the repo root on the host. The file is passed *inside* `--eval` rather than on stdin:
 * given `--eval`, mongosh ignores stdin, and piping the file in instead makes it an interactive
 * session that echoes a prompt around every line of output.
 *
 *   # 1. see what would go, change nothing
 *   docker compose exec -T mongodb mongosh pleiades --quiet \
 *     --eval "var DRY_RUN = true, WITH_FILES = false; $(cat backend/scripts/clear-forum-threads.mongo.js)"
 *
 *   # 2. do it
 *   docker compose exec -T mongodb mongosh pleiades --quiet \
 *     --eval "var DRY_RUN = false, WITH_FILES = false; $(cat backend/scripts/clear-forum-threads.mongo.js)"
 *
 * Set `WITH_FILES = true` to also purge the `forum_files` registry and its GridFS bytes. It is off
 * by default because that registry is built to outlive the post that introduced it
 * (`FORUM_PLAN.md` §10), has a page of its own, and an agent's memory may cite a file id.
 *
 * **This does not touch Qdrant**, which mongosh cannot reach. Clear the search index too, or a
 * deleted post still answers `forum search` as a result nobody can open. Neither the mongo nor the
 * qdrant image ships curl, and Qdrant publishes no host port, so go through the backend — it has
 * node 22 (global `fetch`), sits on the same network, and already knows the URL:
 *
 *   docker compose exec -T backend node -e "fetch(process.env.QDRANT_URL+'/collections/forum_index/points/delete?wait=true',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filter:{must:[]}})}).then(r=>r.text()).then(console.log)"
 *
 * There is no undo.
 */

/* global db, DRY_RUN, WITH_FILES */

// The assignments are prepended to this file inside the same `--eval`, so both are defined by the
// time they are read. The fallbacks make a run that forgot them a dry run, never a surprise delete.
var dry = typeof DRY_RUN === 'undefined' ? true : DRY_RUN;
var withFiles = typeof WITH_FILES === 'undefined' ? false : WITH_FILES;

var FORUM_NOTIFS = { kind: { $in: ['forum_thread', 'forum_mention'] } };
var LINKED_SESSIONS = {
  $or: [{ forum_thread_id: { $ne: null } }, { forum_mention_id: { $ne: null } }],
};

print('database        ' + db.getName());
print('categories      ' + db.forum_categories.countDocuments({}) + '  (kept)');
print('threads         ' + db.forum_threads.countDocuments({}));
print('posts           ' + db.forum_posts.countDocuments({}));
print('mentions        ' + db.forum_mentions.countDocuments({}));
print('notifications   ' + db.notifications.countDocuments(FORUM_NOTIFS) + '  (forum_thread / forum_mention)');
print('sessions        ' + db.sessions.countDocuments(LINKED_SESSIONS) + '  (kept; thread pointers cleared)');
print(
  'files           ' +
    db.forum_files.countDocuments({}) +
    (withFiles ? '  (PURGED, with bytes)' : '  (kept — set WITH_FILES = true to purge)'),
);

if (dry) {
  print('\nDRY_RUN: nothing was changed.');
} else {
  print('');
  print('deleted ' + db.forum_posts.deleteMany({}).deletedCount + '\tforum_posts');
  print('deleted ' + db.forum_threads.deleteMany({}).deletedCount + '\tforum_threads');
  print('deleted ' + db.forum_mentions.deleteMany({}).deletedCount + '\tforum_mentions');
  print('deleted ' + db.notifications.deleteMany(FORUM_NOTIFS).deletedCount + '\tnotifications');

  // Keep the transcript, drop the dangling pointer: a mention run is a real record of an agent's
  // turn. `forum_chain_reset` goes with them — it only ever qualified a chain that no longer exists.
  var cleared = db.sessions.updateMany(LINKED_SESSIONS, {
    $set: { forum_thread_id: null, forum_mention_id: null, forum_chain_reset: false },
  }).modifiedCount;
  print('cleared ' + cleared + '\tsession forum pointers');

  if (withFiles) {
    // GridFS is two ordinary collections; with the whole registry going, both are emptied wholesale
    // rather than file by file.
    var bodies = db.getCollection('forum_files.files').deleteMany({}).deletedCount;
    db.getCollection('forum_files.chunks').deleteMany({});
    print('deleted ' + bodies + '\tGridFS file bodies');
    print('deleted ' + db.forum_files.deleteMany({}).deletedCount + '\tforum_files');
  }

  print(
    '\ndone: ' +
      db.forum_categories.countDocuments({}) +
      ' categories kept, ' +
      db.forum_threads.countDocuments({}) +
      ' threads remaining.',
  );
  print('NOW CLEAR THE SEARCH INDEX — see the header of this file, or stale hits persist.');
}
