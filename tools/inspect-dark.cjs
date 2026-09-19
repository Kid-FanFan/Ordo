// 统计预览面板区域（窗口 x 66%~97%，y 12%~60%）内的深色像素量与包围盒
// 用法：npx electron tools/inspect-dark.cjs shots/a.png ...
const { app, nativeImage } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  for (const arg of process.argv.slice(2)) {
    const file = path.isAbsolute(arg) ? arg : path.join(__dirname, "..", arg);
    const img = nativeImage.createFromPath(file);
    const { width, height } = img.getSize();
    const bmp = img.getBitmap(); // BGRA
    const x0 = Math.round(width * 0.66), x1 = Math.round(width * 0.97);
    const y0 = Math.round(height * 0.12), y1 = Math.round(height * 0.6);
    let dark = 0, minX = 1e9, minY = 1e9, maxX = 0, maxY = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        if (bmp[i + 2] < 100 && bmp[i + 1] < 100 && bmp[i] < 100) {
          dark++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    console.log(
      path.basename(file),
      "regionDark=" + dark,
      dark ? `bbox=${minX},${minY}-${maxX},${maxY}` : ""
    );
  }
  app.exit(0);
});
