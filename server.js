import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { networkInterfaces } from "os";
import { existsSync, readFileSync } from "fs";
import QRCode from "qrcode";

// Khi đóng gói bằng pkg (.exe): đọc thư mục public đặt CẠNH file exe (chỉnh sửa được).
// Khi chạy dev (node server.js): đọc public cạnh mã nguồn.
const ROOT_DIR = process.pkg
  ? dirname(process.execPath)
  : dirname(fileURLToPath(import.meta.url));

// Đọc file .env đặt cạnh mã nguồn (dev) hoặc cạnh file exe (khi đóng gói pkg).
// Biến đã có sẵn trong môi trường luôn được ưu tiên hơn giá trị trong .env.
function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile(join(ROOT_DIR, ".env"));

const app = express();
const httpServer = createServer(app);
// serveClient:false -> không cần file client-dist trong exe (đã vendor sẵn vào public/vendor)
const io = new Server(httpServer, { serveClient: false });

app.use(express.static(join(ROOT_DIR, "public")));

const PORT = process.env.PORT || 3000;
const MASTER_GRACE_MS = 60000; // giữ phòng 60s khi master rớt để reload/kết nối lại

/**
 * rooms: Map<roomCode, Room>
 * Room = {
 *   code, masterId,
 *   players: Map<socketId, { name, reaction, buzzed }>,
 *   phase: 'LOBBY' | 'SIGNAL',
 * }
 */
const rooms = new Map();

// Lấy IP LAN (IPv4, không loopback) để điện thoại quét QR vào được.
// Bỏ qua các card ảo (VirtualBox/VMware/Hyper-V/WSL/Docker) thường không tới được từ điện thoại.
function getLanIP() {
  if (process.env.HOST) return { best: process.env.HOST, all: [process.env.HOST] }; // HOST=192.168.1.20 npm start
  const VIRTUAL = /virtual|vbox|vmware|hyper-v|hyperv|wsl|docker|loopback|npcap/i;
  const candidates = [];
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family !== "IPv4" || net.internal) continue;
      const addr = net.address;
      let score = 0;
      if (VIRTUAL.test(name)) score -= 100;
      if (addr.startsWith("192.168.56.")) score -= 100; // dải mặc định VirtualBox host-only
      if (addr.startsWith("169.254.")) score -= 100;     // link-local (không cấu hình được)
      if (addr.startsWith("192.168.")) score += 10;      // LAN gia đình phổ biến
      else if (addr.startsWith("10.")) score += 8;
      else if (addr.startsWith("172.")) score += 2;      // hay là docker
      if (/wi-?fi|wlan|ethernet|lan/i.test(name)) score += 5;
      candidates.push({ address: addr, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return { best: candidates[0]?.address || "localhost", all: candidates.map((c) => c.address) };
}
const { best: LAN_IP, all: ALL_IPS } = getLanIP();
// PUBLIC_URL=https://rcv.nghiacn.cloud khi chạy qua tunnel (Cloudflare/ngrok) để QR trỏ ra ngoài internet.
const BASE_URL = (process.env.PUBLIC_URL || `http://${LAN_IP}:${PORT}`).replace(/\/+$/, "");

// Avatar dễ thương kiểu Kahoot: con vật + nền màu rực rỡ
const ANIMALS = ["🐼","🐰","🦊","🐶","🐱","🐵","🐸","🐷","🐨","🐯","🦁","🐮","🐔","🦄","🐧","🦉","🐢","🐝","🦋","🐳","🐬","🦕","🦖","🐙","🦈","🐴","🐗","🐭","🐹","🦝","🦥","🦦","🦔","🐺","🦩","🦚","🐊","🦒"];
const AV_COLORS = ["#ef476f","#f78c6b","#ffb703","#06d6a0","#118ab2","#4361ee","#7209b7","#f72585","#3a86ff","#fb5607","#8338ec","#2a9d8f","#e76f51","#43aa8b","#d00000","#ff6d00"];

function assignAvatar(room) {
  const used = new Set([...room.players.values()].map((p) => p.avatar?.emoji));
  const free = ANIMALS.filter((a) => !used.has(a));
  const pool = free.length ? free : ANIMALS;
  const emoji = pool[Math.floor(Math.random() * pool.length)];
  const color = AV_COLORS[Math.floor(Math.random() * AV_COLORS.length)];
  return { emoji, color };
}

// Cho phép client gửi lại avatar cũ khi kết nối lại -> giữ nguyên nhận diện.
// Sanitize để tránh chèn CSS/HTML độc hại qua màu/emoji.
function sanitizeAvatar(av) {
  if (!av || typeof av !== "object") return null;
  const color = typeof av.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(av.color) ? av.color : null;
  const emoji = typeof av.emoji === "string" && av.emoji.length > 0 && av.emoji.length <= 8 ? av.emoji : null;
  return color && emoji ? { color, emoji } : null;
}

// Đề bài do Master gửi lên (server chỉ lưu & relay). Sanitize kích thước.
function sanitizeQuestion(q) {
  if (!q || typeof q !== "object") return null;
  const text = typeof q.q === "string" ? q.q.slice(0, 500) : "";
  const img = typeof q.img === "string" ? q.img.slice(0, 2000) : "";
  if (!text && !img) return null; // cho phép đề chỉ có ảnh
  const options = Array.isArray(q.options) ? q.options.slice(0, 8).map((o) => String(o).slice(0, 200)) : [];
  // answer: index đáp án đúng (number) hoặc đáp án dạng chữ (string)
  let answer = null;
  if (typeof q.answer === "number" && Number.isFinite(q.answer)) answer = q.answer;
  else if (typeof q.answer === "string" && q.answer) answer = q.answer.slice(0, 200);
  return { q: text, options, img, answer };
}

// Payload đề gửi cho viewer: CHỈ kèm đáp án khi Master bật "hiện đáp án".
function questionPayload(room) {
  const q = room.question;
  if (!q) return { question: null, reveal: false };
  const pub = { q: q.q, options: q.options, img: q.img };
  if (room.reveal && q.answer !== null && q.answer !== "") pub.answer = q.answer;
  return { question: pub, reveal: !!room.reveal };
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // bỏ ký tự dễ nhầm (I,O,0,1)
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function publicPlayers(room) {
  return [...room.players.entries()].map(([id, p]) => ({
    id,
    name: p.name,
    reaction: p.reaction,
    buzzed: p.buzzed,
    disabled: p.disabled,
    avatar: p.avatar,
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", {
    phase: room.phase,
    players: publicPlayers(room),
  });
}

function allBuzzed(room) {
  const active = [...room.players.values()].filter((p) => !p.disabled);
  return active.length > 0 && active.every((p) => p.buzzed);
}

function computeRanking(room) {
  const valid = [...room.players.entries()]
    .filter(([, p]) => p.buzzed && !p.disabled && typeof p.reaction === "number")
    .sort((a, b) => a[1].reaction - b[1].reaction)
    .map(([id, p], i) => ({ id, name: p.name, reaction: p.reaction, rank: i + 1 }));
  return { winner: valid[0] || null, ranking: valid };
}

function endRound(room) {
  if (room.phase !== "SIGNAL") return;
  room.phase = "LOBBY";
  io.to(room.code).emit("game:results", computeRanking(room));
  broadcastRoom(room);
}

function resetRoundState(room) {
  for (const p of room.players.values()) {
    p.reaction = null;
    p.buzzed = false;
  }
}

io.on("connection", (socket) => {
  // ---- MASTER ----
  socket.on("master:create", async (_, cb) => {
    const code = genCode();
    const room = { code, masterId: socket.id, players: new Map(), phase: "LOBBY", question: null, reveal: false };
    rooms.set(code, room);
    socket.join(code);
    socket.data = { role: "master", code };

    const joinUrl = `${BASE_URL}/?code=${code}`;
    let qr = null;
    try {
      qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320, color: { dark: "#24487e", light: "#fffdf7" } });
    } catch { /* bỏ qua nếu tạo QR lỗi */ }

    cb?.({ ok: true, code, joinUrl, qr });
    broadcastRoom(room);
  });

  // Master tải lại trang / kết nối lại -> gắn lại làm chủ phòng cũ (không tạo phòng mới)
  socket.on("master:reclaim", async ({ code } = {}, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không còn tồn tại" });

    room.masterId = socket.id;
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
    socket.join(code);
    socket.data = { role: "master", code };

    const joinUrl = `${BASE_URL}/?code=${code}`;
    let qr = null;
    try {
      qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320, color: { dark: "#24487e", light: "#fffdf7" } });
    } catch { /* bỏ qua nếu tạo QR lỗi */ }

    cb?.({ ok: true, code, joinUrl, qr, phase: room.phase, players: publicPlayers(room), question: room.question, reveal: room.reveal });
    broadcastRoom(room);
  });

  // Master bấm Start -> RA HIỆU NGAY, tính giờ từ thời điểm này (không delay)
  socket.on("master:start", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    if (room.phase !== "LOBBY") return;
    const active = [...room.players.values()].filter((p) => !p.disabled);
    if (active.length === 0) return;

    resetRoundState(room);
    room.phase = "SIGNAL";
    broadcastRoom(room);
    io.to(room.code).emit("game:signal", { serverTime: Date.now() });
  });

  socket.on("master:reset", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    resetRoundState(room);
    room.phase = "LOBBY";
    io.to(room.code).emit("game:reset");
    broadcastRoom(room);
  });

  // Dừng vòng ngay lập tức và công bố ranking (với những ai đã bấm)
  socket.on("master:stop", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    if (room.phase !== "SIGNAL") return;
    endRound(room);
  });

  // Khóa / mở quyền chơi của 1 người
  socket.on("master:toggleDisable", ({ playerId }) => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    const p = room.players.get(playerId);
    if (!p) return;
    p.disabled = !p.disabled;
    if (p.disabled) { p.buzzed = false; p.reaction = null; } // loại khỏi vòng hiện tại
    io.to(playerId).emit("player:disabled", { disabled: p.disabled });
    broadcastRoom(room);
    if (room.phase === "SIGNAL" && allBuzzed(room)) endRound(room);
  });

  // Chọn / ẩn đề bài hiển thị trên màn chiếu (Master điều khiển)
  socket.on("master:setQuestion", ({ question, reveal } = {}) => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    room.question = question ? sanitizeQuestion(question) : null;
    room.reveal = !!(room.question && reveal);
    io.to(room.code).emit("room:question", questionPayload(room));
  });

  // Viewer bấm ESC ẩn đáp án -> tắt reveal, đồng bộ ngược lại Master
  socket.on("viewer:hideAnswer", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || !room.reveal) return;
    room.reveal = false;
    io.to(room.code).emit("room:question", questionPayload(room));
  });

  // Mở khóa quyền chơi cho tất cả
  socket.on("master:enableAll", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    for (const [id, p] of room.players) {
      if (p.disabled) { p.disabled = false; io.to(id).emit("player:disabled", { disabled: false }); }
    }
    broadcastRoom(room);
  });

  // ---- VIEWER (màn chiếu, chỉ xem) ----
  socket.on("viewer:join", ({ code }, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại" });
    socket.join(code);
    socket.data = { role: "viewer", code };
    cb?.({ ok: true, code, phase: room.phase, players: publicPlayers(room), ...questionPayload(room) });
  });

  // ---- CLIENT ----
  socket.on("client:join", ({ code, name, avatar }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 20) || "Người chơi";
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại" });

    // Kết nối lại: giữ nguyên avatar cũ nếu client gửi kèm (đã sanitize); nếu không thì cấp mới.
    const av = sanitizeAvatar(avatar) || assignAvatar(room);
    room.players.set(socket.id, { name, reaction: null, buzzed: false, disabled: false, avatar: av });
    socket.join(code);
    socket.data = { role: "client", code };
    cb?.({ ok: true, code, phase: room.phase, avatar: av });
    broadcastRoom(room);
  });

  socket.on("client:buzz", ({ reaction }) => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.phase !== "SIGNAL") return; // chỉ tính khi đã ra hiệu
    const p = room.players.get(socket.id);
    if (!p || p.buzzed || p.disabled) return;

    const r = Number(reaction);
    p.reaction = Number.isFinite(r) && r >= 0 ? Math.round(r) : 99999;
    p.buzzed = true;

    broadcastRoom(room);
    if (allBuzzed(room)) endRound(room);
  });

  // ---- DISCONNECT ----
  socket.on("disconnect", () => {
    const code = socket.data?.code;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (room.masterId === socket.id) {
      // Không đóng ngay: giữ phòng 1 khoảng để master reload/kết nối lại rồi reclaim.
      room.masterId = null;
      clearTimeout(room.graceTimer);
      room.graceTimer = setTimeout(() => {
        if (rooms.get(code) === room && room.masterId === null) {
          io.to(code).emit("room:closed");
          rooms.delete(code);
        }
      }, MASTER_GRACE_MS);
      return;
    }

    room.players.delete(socket.id);
    if (room.phase === "SIGNAL" && allBuzzed(room)) endRound(room);
    else broadcastRoom(room);
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🔔 Rung chuông vàng đang chạy!`);
  console.log(`   Master:      ${BASE_URL}/master.html`);
  console.log(`   Người chơi:  ${BASE_URL}/  (hoặc quét QR trên màn Master)`);
  if (ALL_IPS.length > 1) {
    console.log(`   IP khác:     ${ALL_IPS.filter((ip) => ip !== LAN_IP).join(", ")}`);
    console.log(`   (Nếu QR không vào được, chạy lại với: HOST=<ip-đúng> npm start)`);
  }
  console.log("");
});
