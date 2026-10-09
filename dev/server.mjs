import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
http.createServer(async (req,res) => {
    if (req.url === '/api/backends/chat-completions/generate' && req.method === 'POST') {
        req.resume();res.writeHead(200,{'content-type':'text/event-stream'});
        res.end('data: {"choices":[{"delta":{"content":"模拟回复"}}]}\n\ndata: {"usage":{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":800}},"choices":[]}\n\ndata: [DONE]\n\n');return;
    }
    const url = new URL(req.url,'http://localhost');
    const target = path.resolve(root,'.'+(url.pathname==='/'?'/dev/preview.html':decodeURIComponent(url.pathname)));
    if (!target.startsWith(root+path.sep)) {res.writeHead(403).end();return;}
    try {const bytes=await readFile(target);res.setHeader('content-type',target.endsWith('.html')?'text/html; charset=utf-8':target.endsWith('.css')?'text/css':target.endsWith('.js')?'text/javascript':'application/octet-stream');res.end(bytes);}catch{res.writeHead(404).end();}
}).listen(18764,'127.0.0.1',()=>console.log('Preview http://127.0.0.1:18764'));
