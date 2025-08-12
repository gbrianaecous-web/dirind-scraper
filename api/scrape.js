import * as cheerio from "cheerio";

// Optional: enforce Node 18 on Vercel
export const config = { runtime: "nodejs18.x" };

export default async function handler(req, res) {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing ?url" });

    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await r.text();

    // Normalize HTML to keep paragraph/line breaks
    const normalized = html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n");

    const $ = cheerio.load(normalized);
    const text = $.root().text();
    const blocks = text.split(/\n{2,}/g).map(b => b.trim()).filter(Boolean);

    // Regex helpers
    const emailRe = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/ig;
    const phoneRe = /\(\d{2,3}\)\s?\d{3,4}[-\s]?\d{4}|\b\d{3,4}[-\s]?\d{4}\b/g;
    const urlRe   = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/ig;

    // Page meta
    const category = (/\/dap\/([^\/]+)\d*\.html/i.exec(url)||[])[1] || "unknown";
    const guessLang = s => /[áéíóúñ]/i.test(s) ? "es" : "en";
    const scoreFit = d => {
      const x = (d||"").toLowerCase();
      if (/(microfiltra|ultrafiltra|nanofiltra|ósmosis|osmosis|membrana|uf|nf|ro|cartucho|bolsa filtrante|portafiltro|filtración líquid)/.test(x)) return "Membrane filtration";
      if (/(manguera|tubería|grado alimenticio|sanitaria|ptfe|fep|liner)/.test(x)) return "Food-grade tubing/hoses";
      return "General filtration";
    };

    // --- Name cleaning helpers ---
    const GENERIC = new Set([
      "gmail","hotmail","outlook","live","icloud","aol","yahoo",
      "gmx","msn","yopmail","prodigy","telmex","att","icloud","me"
    ]);

    const toTitle = s =>
      s.replace(/\s+/g," ").trim()
       .replace(/\b\w/g, c => c.toUpperCase());

    const secondLevel = host => {
      // get second-level segment: foo.bar.baz -> bar (best-effort)
      const parts = (host||"").toLowerCase().replace(/^www\./,"").split(".");
      if (parts.length <= 2) return parts[0] || "";
      return parts[parts.length - 2];
    };

    const domainFromUrl = u => {
      try {
        const d = new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).hostname;
        return d.replace(/^www\./,"");
      } catch { return ""; }
    };

    const companyFromDomain = d => {
      const sld = secondLevel(d);
      if (!sld || GENERIC.has(sld)) return "";
      return toTitle(sld.replace(/[-_]/g, " "));
    };

    function extractCompanyName(lines, blockText, websites, emails){
      // 1) Try first non-label line that looks like a name
      for (const ln of lines) {
        if (/^(tel|teléfono|email|e-mail|correo|web)\s*:/i.test(ln)) continue;
        if (/@|https?:\/\//i.test(ln)) continue;
        if (ln.trim().length > 3) return toTitle(ln.trim());
      }
      // 2) Try website domain
      const site = (websites || "").split(";")[0]?.trim();
      const siteDom = site ? domainFromUrl(site) : "";
      const siteName = companyFromDomain(siteDom);
      if (siteName) return siteName;

      // 3) Try email domain
      const em = (emails || "").split(";")[0]?.trim();
      const emDom = em.includes("@") ? em.split("@")[1] : "";
      const emailName = companyFromDomain(emDom);
      if (emailName) return emailName;

      // 4) Last resort: any domain-like text in block
      const anyDom = (blockText.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/i)||[])[0] || "";
      const anyName = companyFromDomain(anyDom);
      return anyName || "";
    }

    // ---- Build items ----
    const items = [];
    const seen = new Set();

    for (const b of blocks) {
      if (!/(email|e-mail|correo)\s*:/i.test(b)) continue;

      const lines = b.split(/\n/).map(s => s.trim()).filter(Boolean);

      const emailsArr = (b.match(emailRe)||[]).filter((v,i,a)=>a.indexOf(v)===i);
      const phonesArr = (b.match(phoneRe)||[]).filter((v,i,a)=>a.indexOf(v)===i);
      const urlsArr   = (b.match(urlRe)||[])
        .map(u=>u.replace(/[,;.]$/,""))
        .filter((v,i,a)=>a.indexOf(v)===i);

      const emails   = emailsArr.join("; ");
      const phones   = phonesArr.join("; ");
      const websites = urlsArr.join("; ");

      const cut = lines.findIndex(l => /^(tel|teléfono|email|e-mail|correo|web)\s*:/i.test(l));
      const description = lines.slice(1, cut > 0 ? cut : lines.length).join(" ").trim();

      const lastLines = lines.slice(-4).join(" ");
      const address = /(Col\.|Colonia|CP|C\.P\.|CDMX|Jal\.|NL|Querétaro|Monterrey|Guadalajara|México|Mexico)/i.test(lastLines) ? lastLines : "";

      let company_name = extractCompanyName(lines, b, websites, emails);

      // Simple de-dupe by name+firstEmail
      const key = `${(company_name||"").toLowerCase()}|${(emailsArr[0]||"").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        company_name,
        description,
        emails,
        phones,
        websites,
        address,
        category,
        category_url: url,
        lang: guessLang(b),
        fit_hint: scoreFit(description || b),
        notes: ""
      });
    }

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
