const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("JWT_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required. Set it to your PostgreSQL connection string.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});
pool.on("error", err => console.error("Unexpected PostgreSQL pool error:", err));

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(16) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS characters (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      x DOUBLE PRECISION NOT NULL DEFAULT 480,
      y DOUBLE PRECISION NOT NULL DEFAULT 360,
      health INTEGER NOT NULL DEFAULT 100,
      oxygen DOUBLE PRECISION NOT NULL DEFAULT 100,
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      credits BIGINT NOT NULL DEFAULT 100,
      inventory JSONB NOT NULL DEFAULT '{"iron":0,"crystal":0,"bio_sample":0,"oxygen_tank":2}'::jsonb,
      discovered JSONB NOT NULL DEFAULT '["VERDANT-01"]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}
function issueToken(user) {
  return jwt.sign({ id: String(user.id), username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: "로그인이 필요하거나 로그인 시간이 만료되었습니다." }); }
}
function clamp(n, min, max) {
  const value = Number(n);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}
function safeCharacter(row) {
  return {
    x: Number(row.x), y: Number(row.y), health: Number(row.health),
    oxygen: Number(row.oxygen), level: Number(row.level), xp: Number(row.xp),
    credits: Number(row.credits), inventory: row.inventory,
    discovered: row.discovered
  };
}
async function ensureCharacter(userId) {
  await pool.query("INSERT INTO characters(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING", [userId]);
  const result = await pool.query("SELECT * FROM characters WHERE user_id=$1", [userId]);
  return result.rows[0];
}

app.get("/api/health", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok: true, database: "connected" }); }
  catch { res.status(503).json({ ok: false, database: "unavailable" }); }
});

app.post("/api/register", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  if (!/^[a-zA-Z0-9_]{3,16}$/.test(username))
    return res.status(400).json({ error: "아이디는 영문, 숫자, 밑줄로 3~16자여야 합니다." });
  if (password.length < 8 || password.length > 72)
    return res.status(400).json({ error: "비밀번호는 8~72자여야 합니다." });
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      "INSERT INTO users(username,password_hash) VALUES ($1,$2) RETURNING id, username",
      [username, hash]
    );
    const user = result.rows[0];
    const character = await ensureCharacter(user.id);
    res.json({ token: issueToken(user), user, character: safeCharacter(character) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "이미 사용 중인 아이디입니다." });
    console.error(e); res.status(500).json({ error: "회원가입 중 서버 오류가 발생했습니다." });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  try {
    const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username=$1", [username]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash)))
      return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
    const character = await ensureCharacter(row.id);
    const user = { id: row.id, username: row.username };
    res.json({ token: issueToken(user), user, character: safeCharacter(character) });
  } catch (e) {
    console.error(e); res.status(500).json({ error: "로그인 중 서버 오류가 발생했습니다." });
  }
});

app.get("/api/me", auth, async (req, res) => {
  try {
    const result = await pool.query("SELECT id, username FROM users WHERE id=$1", [req.user.id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "계정을 찾을 수 없습니다." });
    const character = await ensureCharacter(user.id);
    res.json({ user, character: safeCharacter(character) });
  } catch (e) { console.error(e); res.status(500).json({ error: "계정 정보를 불러오지 못했습니다." }); }
});

app.put("/api/save", auth, async (req, res) => {
  const c = req.body || {};
  const inv = c.inventory || {};
  const allowed = ["iron", "crystal", "bio_sample", "oxygen_tank"];
  const inventory = {};
  for (const key of allowed) inventory[key] = Math.floor(clamp(inv[key], 0, 999999));
  const discovered = Array.isArray(c.discovered)
    ? [...new Set(c.discovered.map(v => String(v).slice(0, 40)))].slice(0, 1000) : [];
  try {
    await pool.query(`
      UPDATE characters SET x=$1,y=$2,health=$3,oxygen=$4,level=$5,xp=$6,credits=$7,
      inventory=$8::jsonb,discovered=$9::jsonb,updated_at=NOW() WHERE user_id=$10
    `, [
      clamp(c.x,24,2976), clamp(c.y,24,1776), Math.floor(clamp(c.health,1,100)),
      clamp(c.oxygen,0,100), Math.floor(clamp(c.level,1,999)),
      Math.floor(clamp(c.xp,0,1e9)), Math.floor(clamp(c.credits,0,1e9)),
      JSON.stringify(inventory), JSON.stringify(discovered), req.user.id
    ]);
    res.json({ ok: true, savedAt: new Date().toISOString() });
  } catch (e) { console.error(e); res.status(500).json({ error: "저장에 실패했습니다." }); }
});

const online = new Map();
io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    const result = await pool.query("SELECT id, username FROM users WHERE id=$1", [payload.id]);
    if (!result.rows[0]) return next(new Error("인증 실패"));
    socket.user = result.rows[0];
    next();
  } catch { next(new Error("로그인이 필요합니다.")); }
});
io.on("connection", async socket => {
  try {
    const character = safeCharacter(await ensureCharacter(socket.user.id));
    const player = { id: String(socket.user.id), username: socket.user.username, x: character.x, y: character.y };
    online.set(String(socket.user.id), player);
    socket.emit("world:players", [...online.values()].filter(p => p.id !== String(socket.user.id)));
    socket.broadcast.emit("world:join", player);
    socket.on("player:move", pos => {
      const current = online.get(String(socket.user.id));
      if (!current || !pos) return;
      const nx = clamp(pos.x,24,2976), ny = clamp(pos.y,24,1776);
      if (Math.hypot(nx-current.x,ny-current.y)>100) return;
      current.x=nx; current.y=ny;
      socket.broadcast.emit("player:moved",current);
    });
    socket.on("disconnect", () => {
      online.delete(String(socket.user.id));
      socket.broadcast.emit("world:leave", String(socket.user.id));
    });
  } catch (e) { console.error("Socket initialization failed:",e); socket.disconnect(true); }
});

initializeDatabase().then(() => {
  server.listen(PORT, "0.0.0.0", () => console.log(`GALAXY FRONTIER listening on ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  server.close();
  await pool.end();
  process.exit(0);
});
