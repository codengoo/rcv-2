import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { networkInterfaces } from "os";
import QRCode from "qrcode";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

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
const BASE_URL = `http://${LAN_IP}:${PORT}`;

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
  }));
}

function broadcastRoom(room) {
  io.to(room.code).emit("room:update", {
    phase: room.phase,
    players: publicPlayers(room),
  });
}

function allBuzzed(room) {
  const list = [...room.players.values()];
  return list.length > 0 && list.every((p) => p.buzzed);
}

function computeRanking(room) {
  const valid = [...room.players.entries()]
    .filter(([, p]) => p.buzzed && typeof p.reaction === "number")
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
    const room = { code, masterId: socket.id, players: new Map(), phase: "LOBBY" };
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

  // Master bấm Start -> RA HIỆU NGAY, tính giờ từ thời điểm này (không delay)
  socket.on("master:start", () => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.masterId !== socket.id) return;
    if (room.phase !== "LOBBY") return;
    if (room.players.size === 0) return;

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

  // ---- CLIENT ----
  socket.on("client:join", ({ code, name }, cb) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 20) || "Người chơi";
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Phòng không tồn tại" });

    room.players.set(socket.id, { name, reaction: null, buzzed: false });
    socket.join(code);
    socket.data = { role: "client", code };
    cb?.({ ok: true, code, phase: room.phase });
    broadcastRoom(room);
  });

  socket.on("client:buzz", ({ reaction }) => {
    const room = rooms.get(socket.data?.code);
    if (!room || room.phase !== "SIGNAL") return; // chỉ tính khi đã ra hiệu
    const p = room.players.get(socket.id);
    if (!p || p.buzzed) return;

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
      io.to(code).emit("room:closed");
      rooms.delete(code);
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
