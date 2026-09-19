// 裁剪截图的右侧预览面板区域并放大保存，供直接目检
// 用法：npx electron tools/crop-shot.cjs shots/13-preview-docx.png out.png
const { app, nativeImage } = require("electron");
const path = require("node:path");

app.whenReady().then(() => {
  const [src, out] = process.argv.slice(2);
  const img = nativeImage.createFromPath(path.isAbsolute(src) ? src : path.join(__dirname, "..", src));
  const { width, height } = img.getSize();
  // 右侧预览面板：x 63%~98%，y 12%~60%，2 倍放大便于看清
  const rect = {
    x: Math.round(width * 0.63),
    y: Math.round(height * 0.12),
    width: Math.round(width * 0.35),
    height: Math.round(height * 0.48),
  };
  const crop = img.crop(rect).resize({ quality: "best", width: rect.width * 2, height: rect.height * 2 });
  const dest = path.isAbsolute(out) ? out : path.join(__dirname, "..", out);
  require("node:fs").writeFileSync(dest, crop.toPNG());
  console.log("saved", dest, JSON.stringify(rect));
  app.exit(0);
});
