// Builds dist/isagent.min.js (+ source map) from src/isagent.js
const fs = require("fs");
const path = require("path");
const { minify } = require("terser");

(async () => {
  const root = path.resolve(__dirname, "..");
  const src = fs.readFileSync(path.join(root, "src/isagent.js"), "utf8");
  const out = await minify(
    { "isagent.js": src },
    { compress: { passes: 2 }, mangle: true, format: { comments: /^!/ }, sourceMap: { filename: "isagent.min.js", url: "isagent.min.js.map" } }
  );
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist/isagent.min.js"), out.code);
  fs.writeFileSync(path.join(root, "dist/isagent.min.js.map"), out.map);
  const gz = require("zlib").gzipSync(out.code).length;
  console.log(`dist/isagent.min.js ${out.code.length} bytes, ${gz} gzipped`);
})();
