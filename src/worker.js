// Cloudflare Worker universal downloader (full code from previous message)
// Cloudflare Worker: Universal Downloader (RedNote/XHS + Shopee)
// UI di "/", API di /api/resolve/rednote, /api/resolve/shopee, /api/download
// Hanya untuk konten publik; tidak melewati login/DRM.

const DEFAULT_UA =
  typeof REQUEST_UA !== "undefined" && REQUEST_UA
    ? REQUEST_UA
    : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function isHttpUrl(u) {
  try { const x = new URL(u); return x.protocol === "http:" || x.protocol === "https:"; }
  catch { return false; }
}
function looksLikeShortlink(u) {
  try {
    const host = new URL(u).host;
    return /(^|\.)shp\.ee$/.test(host) || /(^|\.)id\.shp\.ee$/.test(host) || /(^|\.)s\.shopee\.co\.id$/.test(host);
  } catch { return false; }
}
function withMobileHost(u) {
  try {
    const url = new URL(u);
    if (/shopee\.co\.id$/.test(url.host) && !/^m\./.test(url.host)) url.host = "m.shopee.co.id";
    return url.href;
  } catch { return u; }
}
function sanitizeName(name) {
  return (name || "download").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0,80);
}
function headersDesktop() {
  return {
    "User-Agent": DEFAULT_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "id,en;q=0.9"
  };
}
function headersMobile() {
  return {
    ...headersDesktop(),
    "User-Agent": "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36"
  };
}

async function fetchHtml(url, headers, hops = 3, referer = "") {
  let html = "", finalUrl = url;
  for (let i=0; i<hops; i++) {
    const r = await fetch(finalUrl, { redirect: "follow", headers: referer ? { ...headers, Referer: referer } : headers });
    finalUrl = r.url;
    html = await r.text();

    // meta-refresh
    const meta = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^;]+;\s*url=([^"']+)["']/i);
    if (meta) { finalUrl = new URL(meta[1], finalUrl).href; continue; }

    // simple JS redirects
    const js = html.match(/(?:location\.href|location\.replace|window\.location\s*=)\s*['"]([^'"]+)['"]/i);
    if (js) { finalUrl = new URL(js[1], finalUrl).href; continue; }

    break;
  }
  return { html, finalUrl };
}

function collectUrlsGeneric(html, exts = ["mp4","m3u8","jpg","png","webp"]) {
  const urls = new Set();

  // plain
  const rx = new RegExp(`(https?:\\/\\/[^"'\\\\\\s]+?\\.(?:${exts.join("|")}))(?:\\?[^"'\\\\\\s]*)?`,"ig");
  let m; while ((m = rx.exec(html)) !== null) urls.add(m[1]);

  // escaped
  const rxEsc = new RegExp(`(https?:\\\\/\\\\/[^"'\\\\\\s]+?\\.(?:${exts.join("|")}))(?:\\?[^"'\\\\\\s]*)?`,"ig");
  let k; while ((k = rxEsc.exec(html)) !== null) {
    urls.add(k[1].replace(/\\u002F/gi,"/").replace(/\\\\\\//g,"/"));
  }

  return Array.from(urls);
}

/* ===== RedNote / XHS ===== */
async function resolveRednote(u) {
  const { html, finalUrl } = await fetchHtml(u, headersDesktop(), 3, "https://www.xiaohongshu.com");
  const ogVideo = (html.match(/property=["']og:video(:url)?["'][^>]*content=["']([^"']+)["']/i) || [,,""])[2];
  const ogImage = (html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i) || [,""])[1];
  const title = (html.match(/<title>([^<]+)<\\/title>/i) || [,""])[1]?.trim();

  const urls = collectUrlsGeneric(html, ["mp4","m3u8","jpg","png","webp"]);
  if (ogVideo) urls.push(ogVideo);

  const media = urls
    .filter(u => /(mp4|m3u8)$/i.test(new URL(u).pathname))
    .map(u => ({ url: u, type: u.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4" }));

  if (!media.length && !ogImage) return { ok:false, error:"Tidak menemukan media langsung (mungkin butuh login/DRM)." };
  return { ok:true, page: finalUrl, title: title || "", cover: ogImage || "", media };
}

/* ===== Shopee ===== */
function collectUrlsShopee(html) {
  const urls = new Set(collectUrlsGeneric(html, ["mp4","m3u8"]));

  // Key hints
  const keyHints = [
    /"mp4_url"\\s*:\\s*"([^"]+)"/ig,
    /"video_url"\\s*:\\s*"([^"]+)"/ig,
    /"playUrl"\\s*:\\s*"([^"]+)"/ig,
    /"url"\\s*:\\s*"([^"]+\\.mp4)"/ig,
    /"stream"\\s*:\\s*"([^"]+)"/ig
  ];
  keyHints.forEach(re => {
    let m; while ((m = re.exec(html)) !== null) {
      const val = (m[1] || "").replace(/\\u002F/gi,"/").replace(/\\\//g,"/");
      const matchUrl = val.match(/https?:\\/\\/[^\\s"'\\]+/);
      if (matchUrl) urls.add(matchUrl[0]);
    }
  });

  return Array.from(urls);
}
function rankMedia(urls) {
  const items = urls.map(u => ({
    url: u,
    type: u.includes(".m3u8") ? "application/x-mpegURL" : "video/mp4",
    score: u.includes(".mp4") ? 2 : 1
  }));
  items.sort((a,b) => b.score - a.score || a.url.length - b.url.length);
  const seen = new Set(); const out = [];
  for (const it of items) if (!seen.has(it.url)) { seen.add(it.url); out.push({ url: it.url, type: it.type }); }
  return out;
}
async function expandShopeeShort(url) {
  const H = { ...headersDesktop(), Referer: "https://shopee.co.id/" };
  try {
    let r0 = await fetch(url, { method:"HEAD", redirect:"manual", headers: H });
    let loc = r0.headers.get("location");
    if (!loc) {
      r0 = await fetch(url, { method:"GET", redirect:"manual", headers: H });
      loc = r0.headers.get("location");
      if (!loc) {
        const html0 = await r0.text();
        const meta = html0.match(/<meta[^>]+http-equiv=["']refresh["'][^>]*content=["'][^;]+;\\s*url=([^"']+)["']/i);
        if (meta) loc = meta[1];
      }
    }
    if (loc) return new URL(loc, url).href;
  } catch {}
  return url;
}
async function resolveShopee(startUrl) {
  if (!isHttpUrl(startUrl)) return { ok:false, error:"URL tidak valid" };
  let url = startUrl;
  if (looksLikeShortlink(url)) url = await expandShopeeShort(url);

  const HD = { ...headersDesktop(), Referer: "https://shopee.co.id/" };
  const HM = { ...headersMobile(),  Referer: "https://shopee.co.id/" };

  const candidates = [
    { label:"desktop", url, headers: HD },
    { label:"mobile-ua", url, headers: HM },
    { label:"mobile-host", url: withMobileHost(url), headers: HM },
  ];

  let title = "", page = "", media = [];
  for (const c of candidates) {
    const { html, finalUrl } = await fetchHtml(c.url, c.headers, 3, "https://shopee.co.id/");
    title = (html.match(/<title>([^<]+)<\\/title>/i) || [,""])[1]?.trim() || title;
    page = finalUrl || page;
    const urls = collectUrlsShopee(html);
    media = rankMedia(urls);
    if (media.length) break;
  }

  if (!media.length) {
    return { ok:false, error:"Tidak menemukan URL video langsung. Pakai link produk penuh (bukan shortlink). Jika tetap gagal, kemungkinan video perlu login/DRM atau hanya versi watermark." };
  }
  return { ok:true, page, title, media };
}

/* ===== UI ===== */
const HTML = `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Universal Downloader — RedNote & Shopee</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>
  html,body{background:#0B1221;color:#E6EAF2}
  .card{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px}
  .btn{background:#F97316;color:#0B1221;padding:.6rem 1rem;border-radius:12px;font-weight:800}
  .input{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);padding:.7rem .9rem;border-radius:.8rem;width:100%}
  .muted{opacity:.85}
</style>
</head>
<body>
<header class="max-w-3xl mx-auto px-4 py-6">
  <div class="text-2xl font-extrabold">Universal Downloader</div>
  <div class="muted text-sm">Mendukung <b>RedNote/XHS</b> & <b>Shopee</b> (publik). Tidak melewati login/DRM.</div>
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
    <button id="go" class="btn">Resolve & Tampilkan Link Unduhan</button>
    <div id="hint" class="text-xs muted mt-1"></div>
    <div id="out" class="text-sm"></div>
  </section>
</main>
<script>
  const $=id=>document.getElementById(id);
  const hints={rednote:'Tempel link RedNote/XHS publik (xhslink.com / xiaohongshu.com).',shopee:'Pakai link produk Shopee penuh (lebih stabil daripada shortlink).'};
  $('hint').textContent=hints[$('source').value];$('source').addEventListener('change',()=>$('hint').textContent=hints[$('source').value]);
  $('go').addEventListener('click',async()=>{
    const src=$('source').value, url=$('inp').value.trim();
    $('out').textContent='Memproses...';
    if(!url) return $('out').textContent='Tempel URL dulu.'; if(!$('agree').checked) return $('out').textContent='Centang penggunaan pribadi dulu.';
    const data=await fetch('/api/resolve/'+src+'?url='+encodeURIComponent(url)).then(r=>r.json()).catch(()=>({ok:false,error:'Gagal terhubung ke server'}));
    if(!data.ok) return $('out').textContent=data.error||'Tidak ada media ditemukan.';
    let html=''; if(data.title) html+=\`<div class="mb-2"><b>Judul:</b> \${data.title}</div>\`;
    if(data.cover) html+=\`<img src="\${data.cover}" class="max-h-40 rounded mb-3"/>\`;
    if(data.media?.length){ html+='<div class="mb-2"><b>Media ditemukan:</b></div>';
      data.media.forEach((m,i)=>{ const name=\`\${src}-media-\${i+1}\`;
        const dl='/api/download?url='+encodeURIComponent(m.url)+'&filename='+encodeURIComponent(name)+'&referer='+encodeURIComponent(data.page||url);
        html+=\`<div class="mb-2 p-2 rounded bg-white/5 border border-white/10"><div class="text-xs muted">\${m.type}</div><div class="truncate">\${m.url}</div><a class="btn mt-2 inline-block" href="\${dl}">Download</a></div>\`;});
    }
    $('out').innerHTML=html||'Tidak ada media langsung yang ditemukan.';
  });
</script>
</body>
</html>`;

async function handleDownload(reqUrl) {
  const u = reqUrl.searchParams.get("url");
  const filename = sanitizeName(reqUrl.searchParams.get("filename") || "download");
  const referer = reqUrl.searchParams.get("referer");
  if (!isHttpUrl(u)) return new Response("URL tidak valid", { status: 400 });

  const headers = { "User-Agent": DEFAULT_UA };
  if (referer && isHttpUrl(referer)) headers["Referer"] = referer;

  const r = await fetch(u, { headers, redirect: "follow" });
  if (!r.ok) return new Response("Gagal mengunduh: " + r.status, { status: 400 });

  const ct = r.headers.get("content-type") || "application/octet-stream";
  const ext = (ct.match(/\\/(\\w+)/)?.[1] || (u.includes(".m3u8") ? "m3u8" : "bin")).toLowerCase();

  const h = new Headers(r.headers);
  h.set("Content-Type", ct);
  h.set("Content-Disposition", `attachment; filename="${filename}.${ext}"`);
  return new Response(r.body, { status: 200, headers: h });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (pathname === "/") {
      return new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/health") {
      return new Response("ok", { status: 200 });
    }
    if (pathname === "/api/resolve/rednote") {
      const raw = url.searchParams.get("url");
      if (!isHttpUrl(raw)) return new Response(JSON.stringify({ ok:false, error:"URL tidak valid" }), { status: 400, headers: { "content-type": "application/json" } });
      const data = await resolveRednote(raw);
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/resolve/shopee") {
      const raw = url.searchParams.get("url");
      if (!isHttpUrl(raw)) return new Response(JSON.stringify({ ok:false, error:"URL tidak valid" }), { status: 400, headers: { "content-type": "application/json" } });
      const data = await resolveShopee(raw);
      return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (pathname === "/api/download") {
      return handleDownload(url);
    }

    return new Response("Not Found", { status: 404 });
  }
};
