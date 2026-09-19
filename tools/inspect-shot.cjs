// 采样截图右侧预览区域的像素多样性：判断预览体是否真的空白（还是截图合成问题）
// 用法：npx electron tools/inspect-shot.cjs shots/10-preview-html.png ...
const { app, nativeImage } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  for (const arg of process.argv.slice(2)) {
    const file = path.isAbsolute(arg) ? arg : path.join(__dirname, "..", arg);
    const img = nativeImage.createFromPath(file);
    const size = img.getSize();
    if (!size.width) {
      console.log(file, "读取失败");
      continue;
    }
    const { width, height } = size;
    const x0 = Math.round(width * 0.66), x1 = Math.round(width * 0.97);
    const y0 = Math.round(height * 0.2), y1 = Math.round(height * 0.62);
    const counts = new Map();
    let samples = 0;
    const bmp = img.getBitmap(); // BGRA
    for (let y = y0; y < y1; y += 4) {
      for (let x = x0; x < x1; x += 4) {
        const i = (y * width + x) * 4;
        const key = `${bmp[i + 2]},${bmp[i + 1]},${bmp[i]}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        samples++;
      }
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(path.basename(file), `${width}x${height}`, `distinct=${counts.size}/${samples}`, "::", top.map(([c, n]) => `${c}:${n}`).join(" "));
  }
  app.exit(0);
});
