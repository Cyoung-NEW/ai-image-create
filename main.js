// Cloudflare Worker - AI 图像生成器
// 既负责返回前端 HTML，也负责代理调用速创 API

const SUBMIT_URL = "https://api.wuyinkeji.com/api/async/image_gpt";
const DETAIL_URL = "https://api.wuyinkeji.com/api/async/detail";
const MAX_UPLOAD = 30 * 1024 * 1024; // 30MB
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const CHUNK_SIZE = 60 * 1024; // 60KB（Deno KV 单 value 上限 64KB，留余量）
let _kv = null;
async function getKv() {
  if (_kv) return _kv;
  if (typeof Deno === "undefined" || !Deno.openKv) throw new Error("KV 不可用");
  _kv = await Deno.openKv();
  return _kv;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/api/submit" && request.method === "POST") {
      return handleSubmit(request);
    }
    if (url.pathname === "/api/detail" && request.method === "GET") {
      return handleDetail(url);
    }
    if (url.pathname === "/api/upload" && request.method === "POST") {
      return handleUpload(request, url);
    }
    if (url.pathname === "/api/delete-img" && request.method === "POST") {
      return handleDelete(request);
    }
    if (url.pathname.startsWith("/img/") && request.method === "GET") {
      return handleImage(url.pathname.slice(5));
    }

    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

async function handleUpload(request, url) {
  try {
    const ct = request.headers.get("content-type") || "image/png";
    if (!ct.startsWith("image/")) return json({ error: "仅支持图片" }, 400);
    const buf = new Uint8Array(await request.arrayBuffer());
    if (!buf.byteLength) return json({ error: "空文件" }, 400);
    if (buf.byteLength > MAX_UPLOAD) return json({ error: "图片过大（>30MB）" }, 413);
    const key = crypto.randomUUID().replace(/-/g, "");
    const kv = await getKv();
    const chunks = Math.ceil(buf.byteLength / CHUNK_SIZE);
    await kv.set(["img", key, "meta"], { ct, size: buf.byteLength, chunks }, { expireIn: UPLOAD_TTL_MS });
    for (let i = 0; i < chunks; i++) {
      const slice = buf.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      await kv.set(["img", key, "data", i], slice, { expireIn: UPLOAD_TTL_MS });
    }
    return json({ url: `${url.origin}/img/${key}` });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

async function handleDelete(request) {
  try {
    const { keys } = await request.json();
    if (!Array.isArray(keys)) return json({ error: "keys 必须是数组" }, 400);
    const kv = await getKv();
    for (const k of keys) {
      if (typeof k !== "string" || !/^[a-f0-9]+$/i.test(k)) continue;
      const meta = await kv.get(["img", k, "meta"]);
      const chunks = (meta.value && meta.value.chunks) || 0;
      await kv.delete(["img", k, "meta"]);
      for (let i = 0; i < chunks; i++) {
        await kv.delete(["img", k, "data", i]);
      }
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}

async function handleImage(key) {
  const kv = await getKv();
  const meta = await kv.get(["img", key, "meta"]);
  if (!meta.value) return new Response("not found", { status: 404 });
  const { ct, size, chunks } = meta.value;
  const out = new Uint8Array(size);
  let offset = 0;
  for (let i = 0; i < chunks; i++) {
    const r = await kv.get(["img", key, "data", i]);
    if (!r.value) return new Response("incomplete", { status: 500 });
    out.set(r.value, offset);
    offset += r.value.byteLength;
  }
  return new Response(out, {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function handleSubmit(request) {
  try {
    const body = await request.json();
    const key = (body.api_key || "").trim();
    const prompt = (body.prompt || "").trim();
    const size = body.size || "1:1";
    const urls = Array.isArray(body.urls) ? body.urls.filter(u => typeof u === "string" && u) : [];
    if (!key || !prompt) {
      return json({ error: "api_key 和 prompt 都不能为空" }, 400);
    }
    const payload = { prompt, size };
    if (urls.length) payload.urls = urls;
    const r = await fetch(`${SUBMIT_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: key, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    return json(data, r.status);
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

async function handleDetail(url) {
  try {
    const key = (url.searchParams.get("api_key") || "").trim();
    const tid = (url.searchParams.get("id") || "").trim();
    if (!key || !tid) return json({ error: "api_key 和 id 都不能为空" }, 400);
    const target = `${DETAIL_URL}?key=${encodeURIComponent(key)}&id=${encodeURIComponent(tid)}`;
    const r = await fetch(target, {
      method: "GET",
      headers: { Authorization: key, "Content-Type": "application/json" },
    });
    const data = await r.json();
    return json(data, r.status);
  } catch (e) {
    return json({ error: String(e) }, 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const INDEX_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AI 图像生成器</title>
<style>
  :root {
    --bg-0: #06070d;
    --bg-1: #0c0e18;
    --panel: rgba(20, 22, 36, 0.6);
    --border: rgba(255,255,255,0.07);
    --border-strong: rgba(255,255,255,0.12);
    --text: #e9eaf2;
    --muted: #8a8fa6;
    --muted-2: #6a6f85;
    --accent-a: #c084fc;
    --accent-b: #f0abfc;
    --accent-c: #f9a8d4;
  }
  [data-theme="light"] {
    --bg-0: #f7f5fb;
    --bg-1: #ffffff;
    --panel: rgba(255, 255, 255, 0.75);
    --border: rgba(0,0,0,0.08);
    --border-strong: rgba(0,0,0,0.14);
    --text: #1a1b2e;
    --muted: #5b6072;
    --muted-2: #8b8fa3;
  }
  [data-theme="light"] body {
    background:
      radial-gradient(900px 500px at 8% -5%, rgba(168,85,247,0.12), transparent 60%),
      radial-gradient(900px 500px at 100% 100%, rgba(236,72,153,0.10), transparent 60%),
      linear-gradient(180deg, #f7f5fb, #ffffff);
  }
  [data-theme="light"] .input,
  [data-theme="light"] .select,
  [data-theme="light"] .textarea { background: rgba(0,0,0,0.02); }
  [data-theme="light"] .icon-btn { background: rgba(0,0,0,0.03); }
  [data-theme="light"] .icon-btn:hover { background: rgba(0,0,0,0.06); }
  [data-theme="light"] .opt { background: rgba(0,0,0,0.015); }
  [data-theme="light"] .opt:hover { background: rgba(0,0,0,0.04); }
  [data-theme="light"] .tip,
  [data-theme="light"] .img-card { background: rgba(0,0,0,0.02); }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    color: var(--text);
    background:
      radial-gradient(900px 500px at 8% -5%, rgba(168,85,247,0.18), transparent 60%),
      radial-gradient(900px 500px at 100% 100%, rgba(236,72,153,0.14), transparent 60%),
      linear-gradient(180deg, var(--bg-0), var(--bg-1));
    min-height: 100vh;
  }
  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 18px 32px; }
  .logo { display:flex; align-items:center; gap: 8px; font-weight: 600; font-size: 16px;
    background: linear-gradient(90deg, #c084fc, #f0abfc, #f9a8d4);
    -webkit-background-clip: text; background-clip: text; color: transparent;
  }
  .topbar-right { display:flex; gap: 10px; }
  .icon-btn { background: rgba(255,255,255,0.04); border: 1px solid var(--border); color: var(--text); padding: 7px 12px; border-radius: 9px; font-size: 13px; cursor: pointer; }
  .icon-btn:hover { background: rgba(255,255,255,0.07); }
  .hero { text-align: center; padding: 28px 20px 14px; }
  .hero h1 { margin: 0; font-size: 38px; font-weight: 700; letter-spacing: 1px;
    background: linear-gradient(90deg, #b388ff, #e9a3ff 50%, #ffaad4);
    -webkit-background-clip: text; background-clip: text; color: transparent;
    display: inline-flex; align-items: center; gap: 10px;
  }
  .hero p { color: var(--muted); font-size: 14px; margin-top: 10px; }
  .layout { display: grid; grid-template-columns: 380px 1fr; gap: 22px; max-width: 1240px; margin: 18px auto 40px; padding: 0 24px; }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: 22px; backdrop-filter: blur(14px); }
  .panel-title { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; margin-bottom: 18px; }
  .panel-title .ic { color: var(--accent-a); }
  .label { display:flex; justify-content: space-between; align-items: center; font-size: 13px; margin: 16px 0 8px; font-weight: 500; }
  .label .muted { color: var(--muted-2); font-weight: 400; font-size: 12px; }
  .input, .select, .textarea { width: 100%; background: rgba(255,255,255,0.03); border: 1px solid var(--border-strong); border-radius: 10px; padding: 11px 13px; color: var(--text); font-size: 13px; outline: none; font-family: inherit; transition: border-color .2s, box-shadow .2s; }
  .input:focus, .select:focus, .textarea:focus { border-color: rgba(192,132,252,0.5); box-shadow: 0 0 0 3px rgba(192,132,252,0.12); }
  .textarea { min-height: 100px; resize: vertical; }
  .input-wrap { position: relative; }
  .input-wrap .eye { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; color: var(--muted); cursor: pointer; padding: 4px; }
  .hint { color: var(--muted-2); font-size: 11px; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .grid.cols-4 { grid-template-columns: repeat(4, 1fr); }
  .opt { background: rgba(255,255,255,0.02); border: 1px solid var(--border-strong); border-radius: 9px; padding: 10px 6px; text-align: center; cursor: pointer; transition: all .15s; user-select: none; }
  .opt:hover { background: rgba(255,255,255,0.05); }
  .opt.active { border-color: rgba(192,132,252,0.7); background: rgba(192,132,252,0.08); box-shadow: 0 0 0 1px rgba(192,132,252,0.4) inset; }
  .opt .icon { color: var(--muted); margin-bottom: 4px; }
  .opt.active .icon { color: var(--accent-a); }
  .opt .name { font-size: 13px; font-weight: 600; }
  .opt .dim { font-size: 11px; color: var(--muted-2); margin-top: 2px; }
  .opt .num { font-size: 14px; font-weight: 600; padding: 4px 0; }
  .upload-zone { margin-top: 8px; border: 1px dashed var(--border-strong); border-radius: 10px; padding: 14px; text-align: center; cursor: pointer; background: rgba(255,255,255,0.02); transition: border-color .15s, background .15s; font-size: 12px; color: var(--muted); }
  .upload-zone:hover, .upload-zone.drag { border-color: rgba(192,132,252,0.6); background: rgba(192,132,252,0.05); color: var(--text); }
  .upload-zone.has-img { padding: 10px; text-align: left; }
  .upload-list { display: flex; flex-direction: column; gap: 6px; }
  .upload-list:not(:empty) + #uploadEmpty { display:none; }
  .upload-item { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 8px; background: rgba(255,255,255,0.025); border: 1px solid var(--border); }
  .upload-item img { width: 48px; height: 48px; object-fit: cover; border-radius: 6px; flex-shrink: 0; }
  .upload-item .info { flex: 1; min-width: 0; font-size: 12px; }
  .upload-item .info .name { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .upload-item .info .status { color: var(--muted-2); font-size: 11px; margin-top: 2px; }
  .upload-item .info .status.ok { color: #86efac; }
  .upload-item .info .status.err { color: #ffb3b3; }
  .upload-item .remove { background: transparent; border: 0; color: var(--muted); cursor: pointer; font-size: 18px; padding: 4px 8px; }
  .upload-item .remove:hover { color: #ffb3b3; }
  .upload-add-hint { color: var(--muted-2); font-size: 11px; text-align: center; padding: 6px; border: 1px dashed var(--border); border-radius: 6px; cursor: pointer; }
  .upload-add-hint:hover { color: var(--text); }
  .submit { margin-top: 20px; width: 100%; border: 0; border-radius: 12px; padding: 14px; font-size: 15px; font-weight: 600; color: #fff; cursor: pointer; background: linear-gradient(90deg, #d8a4f9 0%, #f0abfc 50%, #f9a8d4 100%); box-shadow: 0 12px 30px rgba(217, 156, 252, 0.28); transition: transform .08s ease, box-shadow .2s ease, opacity .2s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
  .submit:hover { transform: translateY(-1px); box-shadow: 0 16px 36px rgba(217, 156, 252, 0.35); }
  .submit:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }
  .result-panel { min-height: 600px; display: flex; flex-direction: column; }
  .result-body { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 30px; text-align: center; }
  .loader-stage { position: relative; width: 260px; height: 260px; display:flex; align-items:center; justify-content: center; }
  .ring { width: 130px; height: 130px; border-radius: 50%;
    background: conic-gradient(from 0deg, rgba(192,132,252,0) 0%, rgba(192,132,252,0.0) 50%, #c084fc 75%, #f0abfc 95%, rgba(240,171,252,0) 100%);
    -webkit-mask: radial-gradient(circle, transparent 56px, #000 58px);
            mask: radial-gradient(circle, transparent 56px, #000 58px);
    animation: spin 1.6s cubic-bezier(.5,.15,.5,.85) infinite;
    filter: drop-shadow(0 0 14px rgba(192,132,252,0.45));
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .stars span { position: absolute; color: #c084fc; opacity: 0.7; animation: twinkle 2.4s ease-in-out infinite; font-size: 14px; }
  .stars span:nth-child(1) { top: 6%;  left: 22%; animation-delay: 0s;   font-size: 16px; color:#f0abfc;}
  .stars span:nth-child(2) { top: 14%; right: 16%; animation-delay: .4s; font-size: 12px; }
  .stars span:nth-child(3) { top: 50%; left: 4%;  animation-delay: .8s; font-size: 10px; color:#f9a8d4;}
  .stars span:nth-child(4) { top: 56%; right: 6%; animation-delay: 1.2s; font-size: 14px; }
  .stars span:nth-child(5) { bottom: 14%; left: 28%; animation-delay: 1.6s; font-size: 11px; color:#f0abfc;}
  .stars span:nth-child(6) { bottom: 8%; right: 22%; animation-delay: 2.0s; font-size: 13px; }
  .stars i { position: absolute; width: 5px; height: 5px; border-radius: 50%; background: rgba(192,132,252,0.55); animation: drift 5s ease-in-out infinite; }
  .stars i:nth-child(7) { top: 30%; left: 12%; animation-delay: 0s; }
  .stars i:nth-child(8) { top: 70%; right: 14%; animation-delay: 1.2s; background: rgba(249,168,212,0.6); }
  .stars i:nth-child(9) { bottom: 28%; left: 50%; animation-delay: 2.4s; }
  @keyframes twinkle { 0%,100%{opacity:.2; transform:scale(.8);} 50%{opacity:1; transform:scale(1.1);} }
  @keyframes drift   { 0%,100%{transform:translateY(0);} 50%{transform:translateY(-8px);} }
  .result-title { font-size: 22px; font-weight: 600; margin-top: 18px; }
  .result-sub { color: var(--muted); font-size: 13px; margin-top: 6px; }
  .tip { margin-top: 22px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 10px; padding: 11px 16px; font-size: 13px; color: var(--muted); display: inline-flex; align-items: center; gap: 8px; }
  .tip .bulb { color: #facc15; }
  .tip .elapsed { color: var(--text); margin-left: 6px; }
  .empty .ring { animation: none; opacity: .55;
    background: conic-gradient(from 0deg, rgba(192,132,252,0.35), rgba(240,171,252,0.5), rgba(249,168,212,0.35), rgba(192,132,252,0.35));
  }
  .grid-imgs { width: 100%; display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
  .img-card { border-radius: 14px; overflow: hidden; border: 1px solid var(--border); background: rgba(0,0,0,0.3); animation: fadeUp .5s ease; }
  .img-card img { display:block; width: 100%; height: auto; }
  .img-meta { display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; font-size: 12px; color: var(--muted); }
  .img-meta a { color: #f0abfc; text-decoration: none; }
  @keyframes fadeUp { from { opacity:0; transform: translateY(10px); } to { opacity:1; transform: translateY(0); } }
  .err { margin-top: 14px; padding: 12px 14px; border-radius: 10px; background: rgba(255,90,90,0.08); border: 1px solid rgba(255,90,90,0.25); color: #ffb3b3; font-size: 13px; white-space: pre-wrap; text-align: left; max-width: 520px; }
  .hidden { display: none !important; }
  .history { max-width: 1240px; margin: 0 auto 40px; padding: 0 24px; }
  .history-head { display:flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .history-head .title { display:flex; align-items:center; gap:8px; font-size: 15px; font-weight: 600; }
  .history-head .title .ic { color: var(--accent-a); }
  .history-head .count { color: var(--muted-2); font-size: 12px; font-weight: 400; margin-left: 6px; }
  .history-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; }
  .hist-card { position: relative; border-radius: 12px; overflow: hidden; border: 1px solid var(--border); background: rgba(0,0,0,0.3); cursor: pointer; transition: transform .15s, box-shadow .2s; }
  .hist-card:hover { transform: translateY(-2px); box-shadow: 0 8px 22px rgba(192,132,252,0.15); }
  .hist-card img { display:block; width: 100%; height: 180px; object-fit: cover; }
  .hist-card .hist-prompt { position: absolute; left:0; right:0; bottom:0; padding: 8px 10px; font-size: 11px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,0.78)); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .hist-empty { color: var(--muted-2); font-size: 13px; text-align: center; padding: 30px; border: 1px dashed var(--border); border-radius: 12px; }
  .footer { border-top: 1px solid var(--border); padding: 16px 32px; display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: var(--muted-2); }
  .footer .heart { color: #ec4899; }
</style>
</head>
<body>
  <header class="topbar">
    <div class="logo"><span>✦</span> AI Image Generator</div>
    <div class="topbar-right">
      <button class="icon-btn" id="themeBtn" title="切换主题">☼</button>
      <button class="icon-btn">ⓘ 关于</button>
    </div>
  </header>

  <section class="hero">
    <h1>AI 图像生成器 <span>✦</span></h1>
    <p>输入您的想法，AI 将为您创造独一无二的图像</p>
  </section>

  <main class="layout">
    <aside class="panel">
      <div class="panel-title"><span class="ic">⚙</span> 设置</div>

      <div class="label">API 提供商</div>
      <select class="select" id="provider"><option>🔒 Cyoung</option></select>

      <div class="label">API Key</div>
      <div class="input-wrap">
        <input class="input" id="apiKey" type="password" placeholder="请输入您的 API Key" autocomplete="off" />
        <button class="eye" id="eyeBtn" type="button" title="显示/隐藏">👁</button>
      </div>
      <div class="hint">您的 API Key 仅在本地保存</div>

      <div class="label">模型 (可选)</div>
      <select class="select" id="model"><option>自动选择</option></select>

      <div class="label">图片尺寸</div>
      <div class="grid" id="sizeGrid">
        <div class="opt active" data-size="1:1"><div class="icon">▢</div><div class="name">1:1</div><div class="dim">1024 × 1024</div></div>
        <div class="opt" data-size="16:9"><div class="icon">▭</div><div class="name">16:9</div><div class="dim">1792 × 1024</div></div>
        <div class="opt" data-size="9:16"><div class="icon">▯</div><div class="name">9:16</div><div class="dim">1024 × 1792</div></div>
        <div class="opt" data-size="4:3"><div class="icon">▭</div><div class="name">4:3</div><div class="dim">1365 × 1024</div></div>
        <div class="opt" data-size="3:4"><div class="icon">▯</div><div class="name">3:4</div><div class="dim">1024 × 1365</div></div>
        <div class="opt" data-size="2:3"><div class="icon">▯</div><div class="name">2:3</div><div class="dim">1024 × 1536</div></div>
      </div>

      <div class="label">生成数量</div>
      <div class="grid cols-4" id="countGrid">
        <div class="opt active" data-count="1"><div class="num">1</div></div>
        <div class="opt" data-count="2"><div class="num">2</div></div>
        <div class="opt" data-count="3"><div class="num">3</div></div>
        <div class="opt" data-count="4"><div class="num">4</div></div>
      </div>

      <div class="label">Prompt 提示词 <span class="muted" id="charCount">0 / 1000</span></div>
      <textarea class="textarea" id="prompt" maxlength="1000" placeholder="请输入您想要生成的图像描述... (可在此处直接 Ctrl+V 粘贴图片)"></textarea>
      <div class="hint">描述越详细，生成的图像越符合您的预期</div>

      <div class="label">参考图（可选，可多张）</div>
      <div class="upload-zone" id="uploadZone">
        <input type="file" id="fileInput" accept="image/*" multiple hidden />
        <div id="uploadEmpty">📎 点击 / 拖拽 / 粘贴图片到这里（支持多张）</div>
        <div class="upload-list" id="uploadList"></div>
      </div>
      <div class="hint">生成成功后参考图会自动清理</div>

      <button class="submit" id="genBtn">✦ 生成图像</button>
    </aside>

    <section class="panel result-panel">
      <div class="panel-title"><span class="ic">🖼</span> 生成结果</div>
      <div class="result-body" id="resultBody">
        <div id="stage" class="empty">
          <div class="loader-stage">
            <div class="ring"></div>
            <div class="stars">
              <span>✦</span><span>✧</span><span>✦</span><span>✧</span><span>✦</span><span>✧</span>
              <i></i><i></i><i></i>
            </div>
          </div>
          <div class="result-title" id="stageTitle">等待生成中...</div>
          <div class="result-sub" id="stageSub">点击左侧"生成图像"开始创作</div>
          <div class="tip" id="tipBox">
            <span class="bulb">💡</span>
            <span>提示：生成过程通常需要 30~60 秒，请耐心等待</span>
            <span class="elapsed hidden" id="elapsed"></span>
          </div>
          <div id="error" class="err hidden"></div>
        </div>
      </div>
    </section>
  </main>

  <section class="history">
    <div class="history-head">
      <div class="title"><span class="ic">🕘</span> 历史记录 <span class="count" id="histCount"></span></div>
      <button class="icon-btn" id="clearHistBtn">清空</button>
    </div>
    <div id="historyBody"></div>
  </section>

  <footer class="footer">
    <div>© 2024 AI Image Generator. All rights reserved.</div>
    <div>本网站仅供学习交流，请遵守相关 API 使用条款 <span class="heart">♥</span></div>
  </footer>

<script>
const $ = id => document.getElementById(id);
const STATUS_TEXT = {0:"初始化", 1:"生成中", 2:"成功", 3:"失败"};

const THEME_KEY = "ui_theme";
function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
    $("themeBtn").textContent = "☾";
  } else {
    document.documentElement.removeAttribute("data-theme");
    $("themeBtn").textContent = "☼";
  }
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
$("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

const KEY_STORE = "wuyin_api_key";
$("apiKey").value = localStorage.getItem(KEY_STORE) || "";
$("apiKey").addEventListener("input", e => localStorage.setItem(KEY_STORE, e.target.value));
$("eyeBtn").addEventListener("click", () => { const el = $("apiKey"); el.type = el.type === "password" ? "text" : "password"; });
$("prompt").addEventListener("input", e => { $("charCount").textContent = e.target.value.length + " / 1000"; });

function bindGrid(gridId) {
  const g = $(gridId);
  g.addEventListener("click", e => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    g.querySelectorAll(".opt").forEach(o => o.classList.remove("active"));
    opt.classList.add("active");
  });
}
bindGrid("sizeGrid"); bindGrid("countGrid");
const getSize  = () => $("sizeGrid").querySelector(".opt.active").dataset.size;
const getCount = () => parseInt($("countGrid").querySelector(".opt.active").dataset.count, 10);

function extractImageUrls(payload) {
  const text = JSON.stringify(payload);
  const re = /https?:\/\/[^\s"'\\]+?\.(?:png|jpg|jpeg|webp|gif)/gi;
  const seen = new Set(), out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[0])) { seen.add(m[0]); out.push(m[0]); }
  }
  return out;
}

let uploads = [];
let uploadSeq = 0;
function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function renderUploads() {
  const list = $("uploadList");
  $("uploadZone").classList.toggle("has-img", uploads.length > 0);
  $("uploadEmpty").style.display = uploads.length ? "none" : "";
  list.innerHTML = uploads.map(u =>
    '<div class="upload-item" data-id="' + u.id + '">' +
      '<img src="' + (u.thumb || "") + '" alt="" />' +
      '<div class="info">' +
        '<div class="name">' + escHtml(u.name) + '</div>' +
        '<div class="status ' + (u.status || "") + '">' + escHtml(u.statusText || "") + '</div>' +
      '</div>' +
      '<button class="remove" type="button" data-id="' + u.id + '" title="移除">×</button>' +
    '</div>'
  ).join("") + (uploads.length ? '<div class="upload-add-hint" id="addMore">+ 再加一张</div>' : "");
}
async function uploadFile(file) {
  if (!file || !file.type || !file.type.startsWith("image/")) return;
  if (file.size > 30 * 1024 * 1024) { alert("图片过大，请选 30MB 以下：" + file.name); return; }
  const id = ++uploadSeq;
  const item = { id, name: file.name || "pasted-image", thumb: "", status: "", statusText: "上传中...", url: null, key: null };
  uploads.push(item);
  renderUploads();
  const reader = new FileReader();
  reader.onload = e => { item.thumb = e.target.result; renderUploads(); };
  reader.readAsDataURL(file);
  try {
    const r = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": file.type }, body: file });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "上传失败");
    item.url = data.url;
    item.key = (data.url.split("/img/")[1] || "").split("?")[0];
    item.status = "ok";
    item.statusText = "已上传 ✓";
  } catch (e) {
    item.status = "err";
    item.statusText = "上传失败：" + (e.message || e);
  }
  renderUploads();
}
async function deleteUploads(keys) {
  if (!keys || !keys.length) return;
  try {
    await fetch("/api/delete-img", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({keys}) });
  } catch (e) {}
}
$("fileInput").addEventListener("change", e => {
  for (const f of e.target.files) uploadFile(f);
  e.target.value = "";
});
$("uploadZone").addEventListener("click", e => {
  if (e.target.closest(".remove")) return;
  $("fileInput").click();
});
$("uploadZone").addEventListener("dragover", e => { e.preventDefault(); $("uploadZone").classList.add("drag"); });
$("uploadZone").addEventListener("dragleave", () => $("uploadZone").classList.remove("drag"));
$("uploadZone").addEventListener("drop", e => {
  e.preventDefault();
  $("uploadZone").classList.remove("drag");
  for (const f of e.dataTransfer.files) uploadFile(f);
});
$("uploadList").addEventListener("click", e => {
  const btn = e.target.closest(".remove");
  if (!btn) return;
  e.stopPropagation();
  const id = parseInt(btn.dataset.id, 10);
  const item = uploads.find(u => u.id === id);
  if (item && item.key) deleteUploads([item.key]);
  uploads = uploads.filter(u => u.id !== id);
  renderUploads();
});
document.addEventListener("paste", e => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  let any = false;
  for (const item of items) {
    if (item.type && item.type.startsWith("image/")) {
      uploadFile(item.getAsFile());
      any = true;
    }
  }
  if (any) e.preventDefault();
});

async function submitTask(apiKey, prompt, size, urls) {
  const r = await fetch("/api/submit", { method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({api_key: apiKey, prompt, size, urls}) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || JSON.stringify(data));
  const tid = data && data.data && data.data.id;
  if (!tid) throw new Error("未取得任务 ID：\n" + JSON.stringify(data, null, 2));
  return tid;
}

async function queryTask(apiKey, id) {
  const r = await fetch("/api/detail?api_key=" + encodeURIComponent(apiKey) + "&id=" + encodeURIComponent(id));
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

async function waitForOne(apiKey, prompt, size, urls, startTs, onPhase) {
  const tid = await submitTask(apiKey, prompt, size, urls);
  while (true) {
    if (Date.now() - startTs > 600000) throw new Error("超过 10 分钟仍未出图");
    const resp = await queryTask(apiKey, tid);
    let d = resp.data;
    if (typeof d === "string") { try { d = JSON.parse(d); } catch(e) {} }
    const status = d && d.status;
    onPhase(status);
    if (status === 2) {
      const urls = extractImageUrls(resp);
      if (!urls.length) throw new Error("成功但未提取到 URL：\n" + JSON.stringify(resp, null, 2));
      return { tid, urls };
    }
    if (status === 3) throw new Error("生成失败：" + ((d && d.message) || JSON.stringify(resp)));
    await new Promise(r => setTimeout(r, 1500));
  }
}

const HIST_KEY = "gen_history_v1";
const HIST_MAX = 50;
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch(e) { return []; }
}
function saveHistory(list) { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, HIST_MAX))); }
function addToHistory(prompt, size, items) {
  const list = loadHistory();
  const flat = [];
  items.forEach(it => it.urls.forEach(u => flat.push({ url: u, tid: it.tid, prompt, size, ts: Date.now() })));
  saveHistory([...flat, ...list]);
  renderHistory();
}
function renderHistory() {
  const list = loadHistory();
  const body = $("historyBody");
  $("histCount").textContent = list.length ? "（" + list.length + "）" : "";
  if (!list.length) { body.innerHTML = '<div class="hist-empty">还没有生成记录，去左边创作第一张吧 ✦</div>'; return; }
  body.innerHTML = '<div class="history-grid">' + list.map(it =>
    '<div class="hist-card" data-url="' + it.url + '" title="' + (it.prompt || "").replace(/"/g, "&quot;") + '">' +
      '<img src="' + it.url + '" loading="lazy" alt="" />' +
      '<div class="hist-prompt">' + ((it.prompt || "").replace(/</g, "&lt;")) + '</div>' +
    '</div>'
  ).join("") + '</div>';
}
$("historyBody").addEventListener("click", e => {
  const card = e.target.closest(".hist-card");
  if (card) window.open(card.dataset.url, "_blank", "noopener");
});
$("clearHistBtn").addEventListener("click", () => {
  if (loadHistory().length && confirm("确定清空全部历史记录？")) {
    localStorage.removeItem(HIST_KEY);
    renderHistory();
  }
});
renderHistory();

function renderResults(items) {
  const body = $("resultBody");
  body.innerHTML = '<div class="grid-imgs">' +
    items.map(it => it.urls.map(u =>
      '<div class="img-card"><img src="' + u + '" alt="generated" />' +
      '<div class="img-meta"><span>ID: ' + it.tid.slice(0, 14) + '…</span>' +
      '<a href="' + u + '" target="_blank" rel="noopener">原图 ↗</a></div></div>'
    ).join("")).join("") + '</div>';
}

$("genBtn").addEventListener("click", async () => {
  const apiKey = $("apiKey").value.trim();
  const prompt = $("prompt").value.trim();
  const size   = getSize();
  const count  = getCount();
  if (!apiKey || !prompt) {
    $("resultBody").innerHTML = '<div id="stage"><div class="result-title">等待生成中...</div><div class="err">请填写 API Key 和 Prompt</div></div>';
    return;
  }
  $("resultBody").innerHTML =
    '<div id="stage">' +
    '  <div class="loader-stage"><div class="ring"></div>' +
    '    <div class="stars"><span>✦</span><span>✧</span><span>✦</span><span>✧</span><span>✦</span><span>✧</span><i></i><i></i><i></i></div>' +
    '  </div>' +
    '  <div class="result-title" id="stageTitle">正在提交...</div>' +
    '  <div class="result-sub">AI 正在根据您的提示词创作图像，请稍候</div>' +
    '  <div class="tip"><span class="bulb">💡</span><span>提示：生成过程通常需要 30~60 秒，请耐心等待</span><span class="elapsed" id="elapsed"></span></div>' +
    '  <div id="error" class="err hidden"></div>' +
    '</div>';

  $("genBtn").disabled = true;
  const start = Date.now();
  const timer = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const el = document.getElementById("elapsed");
    if (el) el.textContent = "已用时 " + s + "s";
  }, 250);

  try {
    const okUploads = uploads.filter(u => u.status === "ok");
    const refUrls = okUploads.map(u => u.url);
    const tasks = Array.from({length: count}).map(() =>
      waitForOne(apiKey, prompt, size, refUrls, start, status => {
        const t = document.getElementById("stageTitle");
        if (t) t.textContent = status === 1 ? "AI 正在生成图像..." : (STATUS_TEXT[status] || "处理中...");
      })
    );
    const items = await Promise.all(tasks);
    renderResults(items);
    addToHistory(prompt, size, items);
    if (okUploads.length) {
      deleteUploads(okUploads.map(u => u.key));
      uploads = [];
      renderUploads();
    }
  } catch (e) {
    $("resultBody").innerHTML = '<div id="stage"><div class="result-title">生成失败</div><div class="result-sub">请检查 API Key 或稍后重试</div><div class="err">' + (e.message || String(e)).replace(/</g,"&lt;") + '</div></div>';
  } finally {
    clearInterval(timer);
    $("genBtn").disabled = false;
  }
});
</script>
</body>
</html>`;
