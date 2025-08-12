import * as cheerio from "cheerio";
export const config = { runtime: "nodejs18.x" };

export default async function handler(req, res) {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing ?url" });

    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
    const html = await r.text();
    const $ = cheerio.load(html);

    // --- helpers ---
    const emailRe = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/ig;
    const phoneRe = /(?:\+?52[\s-]?)?(?:\(?\d{2,3}\)?[\s-]?)?\d{3,4}[\s-]?\d{4}/g;
    const urlRe   = /\bhttps?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/ig;
    const tidy = s => (s||"").replace(/\s+/g," ").trim();
    const toTitle = s => tidy(s).replace(/\b\w/g, c => c.toUpperCase());

    const category = (/\/dap\/([^\/]+)\d*\.html/i.exec(url)||[])[1] || "unknown";
    const guessLang = s => /[áéíóúñ]/i.test(s) ? "es" : "en";
    const scoreFit = d => {
      const x = (d||"").toLowerCase();
      if (/(microfiltra|ultrafiltra|nanofiltra|ósmosis|osmosis|membrana|uf|nf|ro|cartucho|bolsa filtrante|portafiltro|filtración líquid)/.test(x)) return "Membrane filtration";
      if (/(manguera|tubería|grado alimenticio|sanitaria|ptfe|fep|liner)/.test(x)) return "Food-grade tubing/hoses";
      return "General filtration";
    };

    // ---------- FIND CARDS: orange + grey ----------
    const cardSet = new Set();
    const cards = [];

    // A) Orange: by "Cotizar" anchor
    $("a").filter((i,el)=>$(el).text().trim().toLowerCase()==="cotizar")
      .each((i,a)=>{
        const parent = $(a).closest("table, tbody, tr, div").first();
        if (parent && parent.length) {
          const key = parent[0]; if (!cardSet.has(key)) { cardSet.add(key); cards.push(parent); }
        }
      });

    // B) Grey: any table/div that contains Tel:
    $("table, div").filter((i,el)=>{
      const t = $(el).text();
      return /\bTel\.?:/i.test(t) && t.length > 120; // avoid tiny fragments
    }).each((i,el)=>{
      const parent = $(el).closest("table").length ? $(el).closest("table") : $(el);
      const key = parent[0]; if (!cardSet.has(key)) { cardSet.add(key); cards.push(parent); }
    });

    // de-dup nested containers by choosing the smallest with Tel:
    const uniq = [];
    for (const c of cards) {
      if (!uniq.some(u => u[0] === c[0] || $.contains(u[0], c[0]) )) uniq.push(c);
    }

    const items = [];
    const seen = new Set();

    for (const card of uniq) {
      const $card = $(card);

      // ---------- COMPANY NAME ----------
      // Look for a short, likely-header line at the top of the card (often ALL CAPS)
      const lines = $card.text().split("\n").map(t=>t.trim()).filter(Boolean);
      let headerIdx = 0;
      // heuristics: line before "Tel:" block, all caps-ish, not starting with labels
      const labelRe = /^(tel\.?|whatsapp|email|web|productos?)/i;
      for (let i=0;i<Math.min(8, lines.length);i++){
        const L = lines[i];
        if (labelRe.test(L)) break;
        if (L.length >= 3 && L.length <= 80) { headerIdx = i; break; }
      }
      let company_name = lines[headerIdx] || "";
      company_name = company_name.replace(/\s*\b(cotizar)\b.*$/i,"").trim();
      if (!company_name) {
        // fallback: first strong/b text
        company_name = tidy($card.find("strong,b").first().text());
      }
      company_name = toTitle(company_name);

      // ---------- DESCRIPTION ----------
      // first paragraph-ish text chunk before labels
      let description = "";
      for (let i = headerIdx+1; i < Math.min(headerIdx+6, lines.length); i++){
        if (labelRe.test(lines[i])) break;
        if ((lines[i]||"").length > 40) { description = lines[i]; break; }
      }

      // ---------- LABELED FIELDS ----------
      const text = $card.text();
      const emails = Array.from(new Set((text.match(emailRe)||[]))).join("; ");
      const phones = Array.from(new Set((text.match(phoneRe)||[]))).join("; ");
      const websites = Array.from(new Set((text.match(urlRe)||[]))).join("; ");

      // WhatsApp explicit
      let whatsapp = "";
      const whatsLine = (text.match(/WhatsApp\s*:\s*([^\n\r]+)/i)||[])[1];
      if (whatsLine) {
        const wPhones = whatsLine.match(phoneRe)||[];
        if (wPhones.length) whatsapp = wPhones.join("; ");
      }

      // Address: pick right-hand / tail lines with place cues
      const tail = lines.slice(-10);
      const looksAddr = s => s && !/@/i.test(s) && (/\d/.test(s) || /c\.?p\.?|cp\s?\d{4,5}/i.test(s)) &&
        /(calle|av\.?|avenida|col\.?|parque|cdmx|méxico|quer[eé]taro|toluca|guadalajara|monterrey|puebla|edo\.?\s?mex|edomex|jal\.?|nl)/i.test(s);
      const address = tail.filter(looksAddr).join(" | ");

      // Products (optional)
      let products = "";
      const htmlFrag = $card.html() || "";
      const prodBlock = htmlFrag.split(/Productos?:/i)[1];
      if (prodBlock) {
        const short = prodBlock.split(/<\/(div|table)>|<hr|<br\s*\/?>\s*<br\s*\/?>/i)[0] || prodBlock;
        const raw = cheerio.load("<root>"+short+"</root>")("root").text();
        const entries = raw.split(/\n|•|-\s+/).map(t=>t.trim()).filter(t => t && t.length > 2 && !/^cotizar$/i.test(t));
        products = Array.from(new Set(entries)).slice(0, 20).join("; ");
      }

      // de-dupe
      const key = `${company_name.toLowerCase()}|${(emails.split(";")[0]||"").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      items.push({
        company_name,
        description,
        emails,
        phones,
        whatsapp,
        websites,
        address,
        products,
        category,
        category_url: url,
        lang: guessLang(text),
        fit_hint: scoreFit(description || text),
        notes: ""
      });
    }

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
