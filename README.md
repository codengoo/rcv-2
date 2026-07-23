# 🔔 Rung chuông vàng

Mini game "bấm chuông nhanh" (buzzer) chạy trong mạng LAN: **Master** ra hiệu → người chơi bấm nút, ai nhanh nhất thắng. Có thêm màn **chiếu đề** (viewer) để trình chiếu câu hỏi + bảng xếp hạng cho khán giả.

3 vai trò, mỗi vai một trang web:

| Vai trò | Trang | Dùng trên |
|---|---|---|
| **Master** (người dẫn) | `/master.html` | Laptop điều khiển |
| **Người chơi** | `/` (index) | Điện thoại (quét QR để vào) |
| **Màn chiếu** (viewer) | `/viewer.html` | Máy chiếu / TV |

---

## 1. Tính năng chính

- Tạo phòng, người chơi quét **QR** vào bằng điện thoại.
- Master **ra hiệu** → đo thời gian phản xạ (đo cục bộ trên máy người chơi cho chính xác), xếp hạng theo ms.
- Khoá/mở quyền chơi từng người; chơi lại nhiều vòng.
- **Đề bài**: nạp từ `public/questions.json`, hỗ trợ **Markdown** + **ảnh**; Master chọn đề, chiếu lên viewer, **hiện đáp án đúng** (popup + pháo hoa trên viewer).
- **Đồng hồ đếm giờ** đã trôi qua trên master & viewer.
- **PWA**: thêm vào màn hình chính iPhone/iPad/Android để chạy full màn hình.
- **Chống rớt kết nối**: người chơi khoá/mở màn hình vẫn tự vào lại phòng; Master **reload trang vẫn giữ phòng** (grace 60s) nhờ `?code=` trên URL.

---

## 2. Kiến trúc & công nghệ

- **Node.js + Express** phục vụ file tĩnh trong `public/`.
- **Socket.IO** cho realtime (ra hiệu, bấm chuông, cập nhật phòng, chiếu đề).
- **State trong RAM** (một `Map` các phòng) — **không có database**. Phòng là tạm thời; restart server = mất hết phòng.
- **qrcode** để sinh QR link tham gia.
- Không có bước build cho frontend: HTML/CSS/JS thuần trong `public/`.

> ⚠️ Vì state ở RAM nên **chỉ chạy 1 instance** (không scale ngang / không load-balancer nhiều node).

---

## 3. Cấu trúc thư mục

```
.
├─ server.js              # Toàn bộ backend: Express + Socket.IO + logic phòng/vòng chơi
├─ build.mjs              # Script đóng gói thành .exe (esbuild -> pkg)
├─ package.json
├─ public/                # Toàn bộ frontend (phục vụ tĩnh ở "/")
│  ├─ index.html          #  - Trang người chơi (join + bấm chuông)
│  ├─ master.html         #  - Bàn điều khiển của Master
│  ├─ viewer.html         #  - Màn chiếu (đề + bảng xếp hạng)
│  ├─ style.css           #  - CSS dùng chung (biến màu, card, nút, avatar…)
│  ├─ questions.json      #  - Danh sách đề bài (SỬA Ở ĐÂY)
│  ├─ images/             #  - Ảnh cho đề bài
│  └─ vendor/             #  - socket.io client (để đóng gói exe không phụ thuộc CDN)
└─ dist/                  # (sinh ra khi build) rcv.exe + public/
```

Mỗi trang trong `public/` là **1 file self-contained** (CSS trong `<style>`, JS trong `<script>`), chỉ dùng chung `style.css` + `vendor/socket.io.min.js`. Không có framework — sửa trực tiếp là thấy (reload trang).

---

## 4. Chạy ở chế độ phát triển (dev)

Yêu cầu: **Node.js ≥ 18**.

```bash
npm install
npm start            # hoặc: npm run dev  (tự reload khi sửa server.js)
```

Console in ra link:
```
Master:      http://192.168.x.x:3000/master.html
Người chơi:  http://192.168.x.x:3000/
```

- Mở **master** trên laptop → **Tạo phòng mới**.
- Người chơi cùng WiFi quét QR (hoặc mở link) → nhập tên → vào.
- Mở **viewer** trên máy chiếu: `/viewer.html?code=<MÃ>` (nút 📺 trên master có sẵn link).

### Cấu hình bằng biến môi trường
| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `PORT` | Cổng server | `3000` |
| `HOST` | Ép IP dùng cho QR/link (khi tự nhận IP sai) | tự dò IP LAN |

Ví dụ: `HOST=192.168.1.50 PORT=8080 npm start`

> Server tự chọn IP LAN (bỏ qua card ảo VirtualBox/VMware/WSL…). Nếu QR không vào được, chạy lại với `HOST=<ip-đúng>`.

---

## 5. Quản lý đề bài — `public/questions.json`

```json
{
  "questions": [
    {
      "q": "Nội dung câu hỏi (hỗ trợ **markdown**)",
      "options": ["A", "**B đậm**", "`C code`", "D"],
      "answer": 1,
      "img": "/images/vidu.png"
    }
  ]
}
```

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `q` | string | Nội dung đề. Hỗ trợ Markdown: `**đậm**`, `*nghiêng*`, `~~gạch~~`, `` `code` ``, `# heading`, danh sách `- ` / `1. `, `> blockquote`, ```` ``` ```` code block, `[link](url)`. Xuống dòng dùng `\n`. |
| `options` | string[] | Đáp án trắc nghiệm (0–8 mục). Bỏ trống `[]` nếu đề tự luận / chỉ có ảnh. Mỗi option cũng render markdown inline. |
| `answer` | number \| string | **Số** = chỉ số đáp án đúng trong `options` (0-based). **Chuỗi** = đáp án dạng chữ (khi không có options). Bỏ qua nếu không muốn có nút "Hiện đáp án". |
| `img` | string | (tuỳ chọn) Đường dẫn ảnh, đặt file trong `public/images/`. |

- **Nút "Tải lại đề" 🔄** trên master nạp lại file này **không cần reload trang / build lại**.
- **Nút "Hiện đáp án" ✓** chỉ bật được khi đang chiếu đề **và** đề có `answer`.
- Đề bằng ảnh có sẵn: `images/image_1.png`, `images/worldcup.png` (sinh bằng script vẽ; thay bằng ảnh thật tuỳ ý).

⚠️ **JSON không cho xuống dòng thật trong chuỗi** — luôn dùng `\n`.

---

## 6. Giao thức realtime (Socket.IO)

Tham khảo nhanh khi maintain `server.js` ↔ các file HTML.

**Client → Server**
| Sự kiện | Ai gửi | Ý nghĩa |
|---|---|---|
| `master:create` | master | Tạo phòng (trả `code`, `joinUrl`, `qr`) |
| `master:reclaim` | master | Giành lại phòng cũ sau khi reload/rớt |
| `master:start` / `master:stop` / `master:reset` | master | Ra hiệu / dừng công bố / chơi lại |
| `master:toggleDisable` / `master:enableAll` | master | Khoá-mở quyền chơi |
| `master:setQuestion` | master | Chiếu đề (`{question, reveal}`) |
| `viewer:join` | viewer | Vào xem 1 phòng |
| `viewer:hideAnswer` | viewer | Bấm ESC ẩn đáp án → tắt reveal, đồng bộ ngược về master |
| `client:join` / `client:buzz` | người chơi | Vào phòng / bấm chuông (`{reaction}` ms) |

**Server → Client**
| Sự kiện | Ý nghĩa |
|---|---|
| `room:update` | `{phase, players[]}` — nguồn dữ liệu chính để vẽ lại UI |
| `room:question` | `{question, reveal}` — chiếu/ẩn đề (đáp án chỉ kèm khi `reveal`) |
| `game:signal` | Master đã ra hiệu (người chơi bắt đầu đo giờ cục bộ) |
| `game:results` / `game:reset` | Công bố kết quả / reset vòng |
| `player:disabled` | Người chơi bị khoá/mở |
| `room:closed` | Phòng đóng (master rời quá 60s) |

**State 1 phòng** (trong RAM): `{ code, masterId, players: Map<socketId, {name, avatar, reaction, buzzed, disabled}>, phase: "LOBBY"|"SIGNAL", question, reveal, graceTimer }`.

---

## 7. Đóng gói thành file .exe (chạy không cần Node)

```bash
npm install          # (nếu chưa) — cần esbuild + pkg trong devDependencies
npm run build:exe
```

Sinh ra thư mục **`dist/`**:
```
dist/
├─ rcv.exe            # ~37MB — đã kèm Node runtime, không cần cài Node
└─ public/            # copy của public (SỬA questions.json ở đây, không cần build lại)
```

**Pipeline** (`build.mjs`): `esbuild` gộp `server.js` + toàn bộ dependencies thành 1 file CJS ~1MB → `pkg` gói kèm Node runtime thành `.exe` → copy `public/` ra cạnh exe.

Các điểm đã xử lý sẵn để đóng gói chạy được:
- `server.js` đọc `public/` từ **thư mục chứa exe** (`process.pkg` → `dirname(process.execPath)`), nên `public/` để rời và sửa được.
- Socket.IO đặt `serveClient:false`; client được **vendor sẵn** ở `public/vendor/socket.io.min.js` (HTML trỏ vào đây thay vì `/socket.io/socket.io.js`).

**Đổi nền tảng**: sửa `TARGET` trong `build.mjs` (`node18-win-x64` → `node18-macos-x64` / `node18-linux-x64`).

> **Không dùng UPX để nén** `rcv.exe`: UPX phá lớp payload của `pkg` (lỗi `Pkg: Error reading from file`). ~37MB là kích thước thực tế nhỏ nhất còn chạy được với hướng đóng gói này.

### Phát hành cho người dùng cuối
- Gửi **cả thư mục `dist/`** (zip lại). Double-click `rcv.exe` → console hiện link Master + QR.
- Lần đầu **Windows Firewall** sẽ hỏi → chọn **Allow** (mạng Private) để máy khác vào được.
- **SmartScreen/antivirus** có thể cảnh báo exe không ký số ("nhà phát hành không xác định") → bấm "Vẫn chạy". Muốn hết cảnh báo cần mua code-signing cert.

---

## 8. Deploy lên cloud (tuỳ chọn)

Là app WebSocket thường trực → **không hợp serverless** (Vercel/Netlify). Dùng host chạy Node liên tục: **Render / Fly.io / Koyeb / Oracle Cloud Always-Free**.

Cần sửa 1 điểm: QR/link đang dựng từ IP LAN (`server.js`):
```js
const BASE_URL = `http://${LAN_IP}:${PORT}`;
```
→ cho đọc từ biến `PUBLIC_URL` (vd `https://rcv.onrender.com`) khi chạy trên cloud. (Chưa làm — làm khi cần deploy.)

`PORT` và listen `0.0.0.0` đã tương thích sẵn.

---

## 9. Ghi chú bảo trì (đọc trước khi sửa)

- **State ở RAM, 1 instance duy nhất.** Restart/redeploy = mất phòng đang chơi → đừng deploy lại giữa buổi.
- **Font + Font Awesome load từ CDN** (Google Fonts, cdnjs). App vẫn chạy offline nhưng **mất icon & sai font** nếu không có internet. Muốn chạy offline hẳn: tải Font Awesome + font Shantell Sans về `public/vendor/` và sửa link trong 3 file HTML.
- **socket.io client là bản vendor** (`public/vendor/socket.io.min.js`). Khi nâng cấp `socket.io`, nhớ copy lại: `cp node_modules/socket.io/client-dist/socket.io.min.js public/vendor/`.
- **Đo thời gian phản xạ ở phía người chơi** (`performance.now()` từ lúc nhận `game:signal`) để tránh lệch mạng — không đo ở server.
- **Master reload** dựa vào `?code=` + `master:reclaim` + grace timer 60s (`MASTER_GRACE_MS` trong `server.js`).
- Các file HTML có thể đã được **Prettier format lại** (thụt dòng khác nhau giữa các file) — không ảnh hưởng chức năng.
- Không có test tự động. Kiểm thử thủ công: mở master + vài tab index + 1 tab viewer trên cùng máy để thử luồng.
