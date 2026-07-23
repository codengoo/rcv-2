// build.mjs — Đóng gói app thành 1 file .exe chạy độc lập (không cần cài Node).
// Chạy:  npm run build:exe
// Kết quả: dist/rcv.exe  +  dist/public/   (phát hành cả thư mục dist/)
//
// Pipeline: esbuild (gộp server + toàn bộ deps thành 1 file CJS nhỏ)
//        -> pkg   (gói kèm Node runtime -> .exe)
//        -> copy public/ ra cạnh exe (server đọc public từ thư mục chứa exe)

import { build } from "esbuild";
import { execSync } from "child_process";
import { rmSync, mkdirSync, cpSync } from "fs";

const TARGET = "node18-win-x64"; // đổi sang node18-macos-x64 / node18-linux-x64 nếu cần

rmSync("build", { recursive: true, force: true });
rmSync("dist", { recursive: true, force: true });
mkdirSync("build", { recursive: true });
mkdirSync("dist", { recursive: true });

console.log("1/3 · esbuild: gộp server.js + deps -> build/app.cjs");
await build({
  entryPoints: ["server.js"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  minify: true,
  outfile: "build/app.cjs",
  logLevel: "warning",
});

console.log(`2/3 · pkg: tạo dist/rcv.exe (${TARGET})`);
execSync(`npx pkg build/app.cjs --targets ${TARGET} --output dist/rcv.exe`, {
  stdio: "inherit",
});

console.log("3/3 · copy public/ -> dist/public/");
cpSync("public", "dist/public", { recursive: true });

console.log("\n✅ Xong! Phát hành cả thư mục dist/ (rcv.exe + public/).");
console.log("   Double-click rcv.exe để chạy; sửa đề tại dist/public/questions.json (không cần build lại).");
