// 由 windows/assets/tray.svg 生成 Windows 图标：icon.ico（16–256 多尺寸，PNG 内嵌）+ icon.png（256）。
// 用 Electron 离屏渲染栅格化 SVG（nativeImage 不认 SVG）。用法：pnpm exec electron scripts/make-windows-icons.cjs
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const assets = path.resolve(__dirname, "..", "windows", "assets");
const svg = fs.readFileSync(path.join(assets, "tray.svg"), "utf8");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** 在页面里把 SVG 按每个尺寸矢量绘制到 canvas（小尺寸也清晰），返回各尺寸 PNG */
async function renderAll(sizes) {
  const win = new BrowserWindow({ width: 300, height: 300, show: false });
  await win.loadURL("about:blank");
  const out = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = "data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}";
    await img.decode();
    return ${JSON.stringify(sizes)}.map((s) => {
      const c = document.createElement("canvas"); c.width = s; c.height = s;
      c.getContext("2d").drawImage(img, 0, 0, s, s);
      return c.toDataURL("image/png").split(",")[1];
    });
  })()`);
  win.destroy();
  return out.map((b64) => Buffer.from(b64, "base64"));
}

/** ICO 容器：头 6 字节 + 每项 16 字节目录 + 各 PNG 原样拼接（Vista 起支持 PNG 项） */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, png }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o); head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.png)]);
}

app.whenReady().then(async () => {
  const images = (await renderAll(SIZES)).map((png, i) => ({ size: SIZES[i], png }));
  fs.writeFileSync(path.join(assets, "icon.ico"), ico(images));
  fs.writeFileSync(path.join(assets, "icon.png"), images.at(-1).png);
  console.log(`wrote icon.ico (${SIZES.join("/")}) and icon.png`);
  app.quit();
});
