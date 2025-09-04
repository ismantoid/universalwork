// Cloudflare Worker: Universal Downloader (RedNote/XHS + Shopee)
// UI di "/"  |  API: /api/resolve/rednote , /api/resolve/shopee , /api/download
// Catatan: hanya untuk konten publik; tidak melewati login / akun / DRM.

function getDefaultUA(env) {
  return (env && env.REQUEST_UA) ?
    env.REQUEST_UA :
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
}

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; }
  catch (_) { return false; }
}

function looksLikeShopeeShort(u) {
  try {
    const host = new URL(u).host;
    return /(^|\.)id\.shp\.ee$/.test(host) || /(^|\.)shp\.ee$/.test(host) || /(^|\.)s\.shopee\.co\.id$/.test(host);
  } catch (_) { return false; }
}

function withMobileHost(u) {
  try {
    const url = new URL(u);
    if (/shopee\.co\.id$/.test(url.host) && !/^m\./.test(url.host)) url.host = "m.shopee.co.id";
    return url.href;
  } catch (_) { return u; }
}

function sanitizeName(name) {
  return (name || "download").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 80);
}

function headersDesktop(ua) {
  return {
    "User-Agent": ua,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id,en;q=0.9"
  };
}
function headersMobile(ua) {
  return {
    "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id,en;q=0.9"
  };
}

async function fetchHtml(url, headers, hops, referer) {
  var html = "", finalUrl = url;
  var i;
  for (i = 0; i < (hops || 3); i++) {
    const opt = { redirect: "follow", headers: headers };
    if (referer) opt.headers = Object.assign({}, headers, { Referer: referer });
    const r = await fetch(finalUrl, opt);
    finalUrl = r.url;
    html = await r.text();

    // meta refresh
    const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=([^"']+)["']/i);
    if (meta && meta[1]) {
      finalUrl = new URL(meta[1], finalUrl).href;
      continue;
    }
    // simple JS redirect
    const js = html.match(/(?:location\.href|location\.replace|window\.location\s*=)\s*['"]([^'"]+)['"]/i);
    if (js && js[1]) {
      finalUrl = new URL(js[1], finalUrl).href;
      continue;
    }
    break;
  }
  return { html: html, finalUrl: finalUrl };
}

function collectUrlsGeneric(html, exts) {
  const set = new Set();
  const list = exts || ["mp4","m3u8","jpg","jpeg","png","webp"];

  // plain
  const rx = new RegExp("(https?:\\/\\/[^\"'\\\\\\s]+?\\.(?:" + list.join("|") + "))(?:\\?[^\"'\\\\\\s]*)?", "ig");
  var m;
  while ((m = rx.exec(html)) !== null) set.add(m[1]);

  // escaped (\/, \u002F)
  const rxEsc = new RegExp("(https?:\\\\/\\\\/[^\"'\\\\\\s]+?\\.(?:" + list.join("|") + "))(?:\\?[^\"'\\\\\\s]*)?", "ig");
  var k;
  while ((k = rxEsc.exec(html)) !== null) {
    var u = k[1].replace(/\\u002F/gi, "/").replace(/\\\\\\//g, "/");
    set.add(u);
  }
  return Array.from(set);
}

/* ---------- RedNote / XHS ---------- */
async function resolveRednote(env, inputUrl) {
  const ua = getDefaultUA(env);
  const { html, finalUrl } = await fetchHtml(inputUrl, headersDesktop(ua), 3, "https://www.xiaohongshu.com");

  // title
  var tMatch = html.match(/<title>([^<]+)<\/title>/i);
  var title = tMatch ? tMatch[1].trim() : "";

  // og:image
  var ogImgMatch = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  var cover = ogImgMatch ? ogImgMatch[1] : "";

  // og:video
  var ogVidMatch = html.match(/property=["']og:video(?::url)?["'][^>]*content=["']([^"']+)["']/i);
  var ogVideo = ogVidMatch ? ogVidMatch[1] : "";

  const urls = collectUrlsGeneric(html, ["mp4","m3u8","jpg","jpeg","png","webp"]);
  if (ogVideo) urls.push(ogVideo);

  const media = [];
  var i;
  for (i = 0; i < urls.length; i++) {
    var u = urls[i];
    try {
      var p = new URL(u).pathname;
      if (/\.m3u8$/i.test(p)) media.push({ url: u, type: "application/x-mpegURL" });
      else if (/\.mp4$/i.test(p)) media.push({ url: u, type: "video/mp4" });
    } catch (_) {}
  }
  return media.length || cover ? { ok: true, page: finalUrl, title: title, cover: cover, media: media }
                              : { ok: false, error: "Tidak menemukan media publik." };
}

/* ---------- Shopee ---------- */
async function expandShopeeShort(env, url) {
  const ua = getDefaultUA(env);
  const baseHeaders = Object.assign({}, headersDesktop(ua), { Referer: "https://shopee.co.id/" });
  try {
    let r0 = await fetch(url, { method: "HEAD", redirect: "manual", headers: baseHeaders });
    let loc = r0.headers.get("location");
    if (!loc) {
      r0 = await fetch(url, { method: "GET", redirect: "manual", headers: baseHeaders });
      loc = r0.headers.get("location");
      if (!loc) {
        const h = await r0.text();
        const m = h.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=([^"']+)["']/i);
        if (m && m[1]) loc = m[1];
      }
    }
    if (loc) return new URL(loc, url).href;
  } catch (_) {}
  return url;
}

function collectUrlsShopee(html) {
  const urls = new Set(collectUrlsGeneric(html, ["mp4","m3u8"]));
  const patterns = [
    /"mp4_url"\s*:\s*"([^"]+)"/ig,
    /"video_url"\s*:\s*"([^"]+)"/ig,
    /"playUrl"\s*:\s*"([^"]+)"/ig,
    /"url"\s*:\s*"([^"]+\.mp4)"/ig,
    /"stream"\s*:\s*"([^"]+)"/ig
  ];
  var i, m;
  for (i = 0; i < patterns.length; i++) {
    var re = patterns[i];
    while ((m = re.exec(html)) !== null) {
      var val = (m[1] || "").replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
      var hit = val.match(/https?:\/\/[^\s"'\\]+/);
      if (hit && hit[0]) urls.add(hit[0]);
    }
  }
  return Array.from(urls);
}

function rankMedia(urls) {
  const items = [];
  var i;
  for (i = 0; i < urls.length; i++) {
    var u = urls[i];
    var type = u.indexOf(".m3u8") !== -1 ? "application/x-mpegURL" : "video/mp4";
    var score = u.indexOf(".mp4") !== -1 ? 2 : 1;
    items.push({ url: u, type: type, score: score });
  }
  items.sort(function(a,b){ return (b.score - a.score) || (a.url.length - b.url.length); });
  const out = [];
  const seen = new Set();
  for (i = 0; i < items.length; i++) {
    if (!seen.has(items[i].url)) {
      seen.add(items[i].url);
      out.push({ url: items[i].url, type: items[i].type });
    }
  }
  return out;
}

async function resolveShopee(env, inputUrl) {
  if (!isHttpUrl(inputUrl)) return { ok: false, error: "URL tidak valid" };

  let url = inputUrl;
  if (looksLikeShopeeShort(url)) url = await expandShopeeShort(env, url);

  const ua = getDefaultUA(env);
  const HD = Object.assign({}, headersDesktop(ua), { Referer: "https://shopee.co.id/" });
  const HM = Object.assign({}, headersMobile(ua),  { Referer: "https://shopee.co.id/" });

  const candidates = [
    { url: url, headers: HD },
    { url: url, headers: HM },
    { url: withMobileHost(url), headers: HM }
  ];

  var title = "", page = "", media = [];
  var i;
  for (i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const got = await fetchHtml(c.url, c.headers, 3, "https://shopee.co.id/");
    var tMatch = got.html.match(/<title>([^<]+)<\/title>/i);
    if (tMatch && tMatch[1]) title = tMatch[1].trim();
    if (got.finalUrl) page = got.finalUrl;

    const list = collectUrlsShopee(got.html);
    media = rankMedia(list);
    if (media.length) break;
  }

  if (!media.length) return { ok: false, error: "Tidak menemukan video publik (mungkin perlu login/DRM). Coba pakai link produk penuh, bukan shortlink." };
  return { ok: true, page: page, title: title, media: media };
}

/* ---------- UI ---------- */
function landingHtml() {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Universal Downloader — Worker</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body{background:#0B1221;color:#E6EAF2}
  .card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:14px}
  .btn{background:#F97316;color:#0B1221;padding:.6rem 1rem;border-radius:.7rem;font-weight:800}
  .input{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:.7rem .9rem;border-radius:.6rem;width:100%}
  .muted{opacity:.85}
</style>
</head>
<body>
<header class="max-w-3xl mx-auto px-4 py-6">
  <div class="text-2xl font-extrabold">Universal Downloader</div>
  <div class="muted text-sm">RedNote/XHS & Shopee (konten publik). Tidak melewati login/DRM.</div>
</header>
<main class="max-w-3xl mx-auto px-4 pb-24 space-y-6">
  <section class="card p-5 space-y-4">
    <div class="grid md:grid-cols-5 gap-3 items-end">
      <div class="md:col-span-1">
        <label class="text-sm">Sumber</label>
        <select id="source" class="input">
          <option value="rednote">RedNote / XHS</option>
          <option value="shopee">Shopee</option>
        </select>
      </div>
      <div class="md:col-span-4">
        <label class="text-sm">URL publik</label>
        <input id="inp" class="input" placeholder="https://...">
      </div>
    </div>
    <label class="flex items-center gap-2 text-sm"><input id="agree" type="checkbox">Hanya untuk penggunaan pribadi</label>
    <button id="go" class="btn">Resolve & Tampilkan Link</button>
    <div id="hint" class="text-xs muted mt-1"></div>
    <div id="out" class="text-sm"></div>
  </section>
</main>
<script>
  const $=id=>document.getElementById(id);
  const hints={rednote:'Tempel link xhslink.com / xiaohongshu.com publik.',shopee:'Pakai link produk Shopee penuh (lebih stabil dibanding shortlink).'};
  $('hint').textContent=hints[$('source').value];$('source').addEventListener('change',()=>$('hint').textContent=hints[$('source').value]);

  $('go').addEventListener('click', async ()=>{
    const src=$('source').value, u=$('inp').value.trim();
    $('out').textContent='Memproses...';
    if(!u) return $('out').textContent='Tempel URL dulu.'; 
    if(!$('agree').checked) return $('out').textContent='Centang penggunaan pribadi dulu.';
    try{
      const res = await fetch('/api/resolve/'+src+'?url='+encodeURIComponent(u));
      const data = await res.json();
      if(!data.ok) return $('out').textContent=data.error||'Tidak ada media ditemukan.';
      let html='';
      if(data.title) html+=\`<div class="mb-2"><b>Judul:</b> \${data.title}</div>\`;
      if(data.cover) html+=\`<img src="\${data.cover}" class="max-h-40 rounded mb-3"/>\`;
      if(data.media && data.media.length){
        html+='<div class="mb-2"><b>Media:</b></div>';
        data.media.forEach((m,i)=>{
          const name=\`\${src}-\${i+1}\`;
          const dl='/api/download?url='+encodeURIComponent(m.url)+'&filename='+encodeURIComponent(name)+'&referer='+encodeURIComponent(data.page||u);
          html+=\`<div class="mb-2 p-2 rounded bg-white/5 border border-white/10">
                    <div class="text-xs muted">\${m.type}</div>
                    <div class="truncate">\${m.url}</div>
                    <a class="btn mt-2 inline-block" href="\${dl}">Download</a>
                  </div>\`;
        });
      }
      $('out').innerHTML=html||'Tidak ada media langsung yang ditemukan.';
    }catch(e){ $('out').textContent='Gagal terhubung ke server.'; }
  });
</script>
</body>
</html>`;
}

/* ---------- download proxy ---------- */
async function handleDownload(env, reqUrl) {
  const u = reqUrl.searchParams.get("url");
  const filename = sanitizeName(reqUrl.searchParams.get("filename") || "download");
  const referer = reqUrl.searchParams.get("referer");
  if (!isHttpUrl(u)) return new Response("URL tidak valid", { status: 400 });

  const headers = { "User-Agent": getDefaultUA(env) };
  if (referer && isHttpUrl(referer)) headers["Referer"] = referer;

  const r = await fetch(u, { headers: headers, redirect: "follow" });
  if (!r.ok) return new Response("Gagal mengunduh: " + r.status, { status: 400 });

  const ct = r.headers.get("content-type") || "application/octet-stream";
  const guess = (function(){
    const m = ct.match(/\/(\w+)/);
    if (m && m[1]) return m[1].toLowerCase();
    if (u.indexOf(".m3u8") !== -1) return "m3u8";
    if (u.indexOf(".mp4") !== -1) return "mp4";
    return "bin";
  })();

  const h = new Headers(r.headers);
  h.set("Content-Type", ct);
  h.set("Content-Disposition", 'attachment; filename="' + filename + '.' + guess + '"');
  return new Response(r.body, { status: 200, headers: h });
}

/* ---------- Worker entry ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === "/") {
      return new Response(landingHtml(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (p === "/health") return new Response("ok", { status: 200 });

    if (p === "/api/resolve/rednote") {
      const raw = url.searchParams.get("url");
      if (!isHttpUrl(raw)) return new Response(JSON.stringify({ ok:false, error:"URL tidak valid" }), { status: 400, headers: { "content-type":"application/json" } });
      const data = await resolveRednote(env, raw);
      return new Response(JSON.stringify(data), { headers: { "content-type":"application/json" } });
    }

    if (p === "/api/resolve/shopee") {
      const raw = url.searchParams.get("url");
      if (!isHttpUrl(raw)) return new Response(JSON.stringify({ ok:false, error:"URL tidak valid" }), { status: 400, headers: { "content-type":"application/json" } });
      const data = await resolveShopee(env, raw);
      return new Response(JSON.stringify(data), { headers: { "content-type":"application/json" } });
    }

    if (p === "/api/download") {
      return handleDownload(env, url);
    }

    return new Response("Not Found", { status: 404 });
  }
};
