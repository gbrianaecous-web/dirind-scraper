import * as cheerio from "cheerio";

export default async function handler(req, res) {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing ?url" });

    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await r.text();

    const normalized = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n");

    const $ = cheerio.load(normalized);
    const text = $.root().text();
    const blocks = text.split(/\n{2,}/g).map(b => b.trim()).filter(Boolean);

    const emailRe = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/ig;
    const phoneRe = /\(\d{2,3}\)\s?\d{3,4}[-\s]?\d{4}|\b\d{3,4}[-\s]?\d{4}\b/g;
    const urlRe   = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/ig;

    const category = (/\/dap\/([^\/]+)\d*\.html/i.exec(url)||[])[1] || "unknown";
    const guessLang = s => /[áéíóúñ]/i.test(s) ? "es" : "en";
    const scoreFit = d => {
      const x = (d||"").toLowerCase();
      if (/(microfiltra|ultrafiltra|nanofiltra|ósmosis|osmosis|membrana|uf|nf|ro|cartucho|bolsa filtrante|portafiltro|filtración líquid)/.test(x)) return "Membrane filtration";
      if (/(manguera|tubería|grado alimenticio|sanitaria|ptfe|fep|liner)/.test(x)) return "Food-grade tubing/hoses";
      return "General filtration";
    };

    const items = [];
    for (const b of blocks) {
      if (!/(email|e-mail|correo)\s*:/i.test(b)) continue;

      const lines = b.split(/\n/).map(s => s.trim()).filter(Boolean);
      const company_name = lines[0] || "";

      const cut = lines.findIndex(l => /^(tel|teléfono|email|e-mail|correo|web)\s*:/i.test(l));
      const description = lines.slice(1, cut > 0 ? cut : lines.length).join(" ").trim();

      const emails   = (b.match(emailRe)||[]).filter((v,i,a)=>a.indexOf(v)===i).join("; ");
      const phones   = (b.match(phoneRe)||[]).filter((v,i,a)=>a.indexOf(v)===i).join("; ");
      const websites = (b.match(urlRe)||[]).map(u=>u.replace(/[,;.]$/,"")).filter((v,i,a)=>a.indexOf(v)===i).join("; ");

      const lastLines = lines.slice(-4).join(" ");
      const address = /(Col\.|Colonia|CP|C\.P\.|CDMX|Jal\.|NL|Querétaro|Monterrey|Guadalajara|México|Mexico)/i.test(lastLines) ? lastLines : "";

      items.push({
        company_name, description, emails, phones, websites, address,
        category, category_url: url, lang: guessLang(b), fit_hint: scoreFit(description || b), notes: ""
      });
    }

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
