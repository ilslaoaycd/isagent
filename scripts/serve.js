// Minimal static file server for the demo and tests: node scripts/serve.js [port]
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json" };

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("not found");
      res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
}

if (require.main === module) {
  const port = Number(process.argv[2]) || 8765;
  createServer().listen(port, "127.0.0.1", () => console.log(`http://localhost:${port}/demo/`));
}

module.exports = { createServer };
