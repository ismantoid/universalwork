export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Hanya route /api/download
    if (url.pathname === "/api/download") {
      const target = url.searchParams.get("url");
      if (!target) {
        return new Response(JSON.stringify({ error: "URL kosong" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        // Fetch halaman target dengan UA custom
        const resp = await fetch(target, {
          headers: { "User-Agent": env.REQUEST_UA || "Mozilla/5.0" },
        });
        const html = await resp.text();

        // Ambil title (tanpa optional chaining)
        let titleMatch = html.match(/<title>([^<]+)<\/title>/i);
        let title = titleMatch ? titleMatch[1].trim() : "";

        // Cari video/mp4 atau webm
        let videoMatch = html.match(/https?:\/\/[^\s"'<>]+?\.(mp4|webm)/i);
        let videoUrl = videoMatch ? videoMatch[0] : null;

        // Cari gambar jpg/png
        let imgMatch = html.match(/https?:\/\/[^\s"'<>]+?\.(jpg|jpeg|png)/i);
        let imageUrl = imgMatch ? imgMatch[0] : null;

        if (!videoUrl && !imageUrl) {
          return new Response(JSON.stringify({ error: "Media tidak ditemukan" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(
          JSON.stringify({
            title,
            video: videoUrl,
            image: imageUrl,
          }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Halaman utama (tes)
    return new Response(
      `<h1>Universal Downloader Worker</h1>
       <p>Gunakan <code>/api/download?url=...</code> untuk scrape.</p>`,
      { headers: { "Content-Type": "text/html; charset=UTF-8" } }
    );
  },
};
