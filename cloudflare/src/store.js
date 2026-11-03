export const now = () => new Date().toISOString();

const schema = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels (chat_id INTEGER PRIMARY KEY,title TEXT NOT NULL DEFAULT '',can_post INTEGER NOT NULL DEFAULT 0,can_delete INTEGER NOT NULL DEFAULT 0,is_member INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tracks (id INTEGER PRIMARY KEY AUTOINCREMENT,file_unique_id TEXT NOT NULL UNIQUE,file_id TEXT NOT NULL,vault_message_id INTEGER NOT NULL,vault_chat_id INTEGER,title TEXT,performer TEXT,file_name TEXT,duration INTEGER NOT NULL DEFAULT 0,file_size INTEGER NOT NULL DEFAULT 0,missing INTEGER NOT NULL DEFAULT 0,indexed_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tracks_search ON tracks(title,performer,file_name);
CREATE INDEX IF NOT EXISTS idx_tracks_source ON tracks(vault_chat_id,vault_message_id);
CREATE TABLE IF NOT EXISTS playlists (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,channel_id INTEGER REFERENCES channels(chat_id) ON DELETE SET NULL,last_published_at TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS playlist_tracks (playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,position INTEGER NOT NULL,PRIMARY KEY(playlist_id,track_id),UNIQUE(playlist_id,position));
CREATE TABLE IF NOT EXISTS published_messages (id INTEGER PRIMARY KEY AUTOINCREMENT,playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,chat_id INTEGER NOT NULL,message_id INTEGER NOT NULL,track_id INTEGER REFERENCES tracks(id) ON DELETE SET NULL,published_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,status TEXT NOT NULL,progress INTEGER NOT NULL DEFAULT 0,total INTEGER NOT NULL DEFAULT 0,skipped INTEGER NOT NULL DEFAULT 0,skipped_titles TEXT NOT NULL DEFAULT '[]',current_track TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS channel_locks (chat_id INTEGER PRIMARY KEY,job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,payload TEXT NOT NULL,due_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,inflight TEXT);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at,id);
CREATE TABLE IF NOT EXISTS updates (id INTEGER PRIMARY KEY,received_at INTEGER NOT NULL);
`;

export class Store {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec(schema);
    const version = Number(this.setting("schema_version", "0"));
    if (version > 1)
      throw new Error("Database was created by a newer version of the app.");
    this.set("schema_version", "1");
    const vault = this.setting("vault_chat_id");
    if (vault !== null) this.checkpoint(vault);
  }
  all(query, ...values) {
    return this.sql.exec(query, ...values).toArray();
  }
  one(query, ...values) {
    return this.all(query, ...values)[0] || null;
  }
  exec(query, ...values) {
    return this.sql.exec(query, ...values);
  }
  atomic(callback) {
    return this.storage.transactionSync(callback);
  }
  setting(key, fallback = null) {
    return (
      this.one("SELECT value FROM settings WHERE key=?", key)?.value ?? fallback
    );
  }
  set(key, value) {
    this.exec(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      String(value),
    );
  }
  checkpoint(vault) {
    const key = `scan_checkpoint:${vault}`;
    if (this.setting(key) === null)
      this.set(key, String(vault) === this.setting("vault_chat_id")
        ? Number(this.setting("scan_cursor", "0")) : 0);
    return Number(this.setting(key));
  }
  tracks(pid) {
    return this.all(
      "SELECT t.*,pt.position FROM playlist_tracks pt JOIN tracks t ON t.id=pt.track_id WHERE pt.playlist_id=? ORDER BY pt.position",
      pid,
    );
  }
  playlists() {
    return this.all(
      `SELECT p.*,c.title channel_title,COALESCE(c.is_member AND c.can_post AND c.can_delete,0) channel_available,COUNT(pt.track_id) track_count FROM playlists p LEFT JOIN channels c ON c.chat_id=p.channel_id LEFT JOIN playlist_tracks pt ON pt.playlist_id=p.id GROUP BY p.id ORDER BY p.created_at,p.id`,
    );
  }
  channel(chat, member) {
    this.exec(
      `INSERT INTO channels VALUES(?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET title=excluded.title,can_post=excluded.can_post,can_delete=excluded.can_delete,is_member=excluded.is_member,updated_at=excluded.updated_at`,
      chat.id,
      chat.title ||
        this.one("SELECT title FROM channels WHERE chat_id=?", chat.id)
          ?.title ||
        "",
      Number(member.status === "administrator" && !!member.can_post_messages),
      Number(member.status === "administrator" && !!member.can_delete_messages),
      Number(!["left", "kicked"].includes(member.status)),
      now(),
    );
  }
  index(message, source = message.chat.id, mid = message.message_id) {
    const a = message.audio;
    if (!a) return;
    this.exec(
      `INSERT INTO tracks(file_unique_id,file_id,vault_message_id,vault_chat_id,title,performer,file_name,duration,file_size,missing,indexed_at) VALUES(?,?,?,?,?,?,?,?,?,0,?) ON CONFLICT(file_unique_id) DO UPDATE SET file_id=excluded.file_id,vault_message_id=excluded.vault_message_id,vault_chat_id=excluded.vault_chat_id,title=excluded.title,performer=excluded.performer,file_name=excluded.file_name,duration=excluded.duration,file_size=excluded.file_size,missing=0,indexed_at=excluded.indexed_at`,
      a.file_unique_id,
      a.file_id,
      mid,
      source,
      a.title ?? null,
      a.performer ?? null,
      a.file_name ?? null,
      a.duration || 0,
      a.file_size || 0,
      now(),
    );
  }
  order(pid, ids) {
    this.atomic(() => {
      this.exec("DELETE FROM playlist_tracks WHERE playlist_id=?", pid);
      ids.forEach((id, index) =>
        this.exec("INSERT INTO playlist_tracks VALUES(?,?,?)", pid, id, index),
      );
    });
  }
  enqueue(kind, payload, delay = 0) {
    return this.one(
      "INSERT INTO tasks(kind,payload,due_at) VALUES(?,?,?) RETURNING id",
      kind,
      JSON.stringify(payload),
      Date.now() + delay,
    ).id;
  }
  updateTask(task, payload, delay = 0) {
    this.exec(
      "UPDATE tasks SET payload=?,due_at=?,inflight=NULL,attempts=0 WHERE id=?",
      JSON.stringify(payload),
      Date.now() + delay,
      task.id,
    );
  }
  job(id) {
    const row = this.one("SELECT * FROM jobs WHERE id=?", id);
    if (!row) return null;
    delete row.state;
    row.skipped_titles = JSON.parse(row.skipped_titles);
    return row;
  }
}
