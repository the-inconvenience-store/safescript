// THROWAWAY PROTOTYPE for safescript-buy.10.
// Run: node packages/engine/prototype-semantic-view/server.mjs
// Check: node packages/engine/prototype-semantic-view/server.mjs --check

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";

const html = await readFile(new URL("./index.html", import.meta.url));

if (process.argv.includes("--check")) {
  const source = html.toString();
  for (const marker of ["Human flow", "Compiler lanes", "Source anchored", "?variant="]) assert.ok(source.includes(marker));
  new Function(source.match(/<script>([\s\S]*)<\/script>/)[1]);
  console.log("prototype checks passed");
} else {
  http.createServer((request, response) => {
    if (request.url === "/favicon.ico") return response.end();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(html);
  }).listen(4173, "127.0.0.1", () => {
    console.log("Semantic view prototype: http://127.0.0.1:4173/prototype/semantic-graph?variant=A");
  });
}
