import { readFileSync } from 'node:fs';
import { getTemplate } from '../core/templates.js';
const src = readFileSync(process.argv[2], 'utf8').replace(/\s+/g, ' ');
const n = (s) => String(s).replace(/\s+/g, ' ').trim();
const out = []; let bad = 0;
const chk = (ver, label, s) => { const ok = src.includes(n(s)); if (!ok) bad++; out.push(`${ok ? 'MATCH ' : 'DIFF  '} ${ver} ${label}: ${n(s).slice(0, 90)}`); };
for (const id of ['WR-PAPER', 'WR-1.0']) {
  const t = getTemplate(id);
  for (const lang of ['en', 'es']) {
    if (id === 'WR-PAPER') chk(id, 'intro.' + lang, t.intro[lang]);
    if (t.instruction) chk(id, 'instruction.' + lang, t.instruction[lang] ?? t.instruction);
    for (const q of t.sections.flatMap(s => s.questions).filter(q => q.origin === 'paper' || id === 'WR-PAPER')) {
      chk(id, q.id + '.' + lang, q.text[lang]);
      if (q.options) for (const o of q.options) chk(id, q.id + '.opt' + o.value + '.' + lang, (q.type === 'rating' ? `(${o.value}) ` : '') + o[lang]);
    }
  }
  if (id === 'WR-1.0') {
    for (const lang of ['en','es']) {
      const intro = n(t.intro[lang]); const withheld = n(t.withheld[0].text[lang]);
      const paper = n(getTemplate('WR-PAPER').intro[lang]);
      const ok = paper.replace(withheld, '').replace(/\s+/g, ' ').trim() === intro; if (!ok) bad++;
      out.push(`${ok ? 'MATCH ' : 'DIFF  '} WR-1.0 intro.${lang} = paper intro minus withheld G1 sentence`);
    }
  }
}
console.log(out.join('\n')); console.log(bad ? `${bad} difference(s)` : 'All checked strings match the paper source verbatim.'); process.exit(bad ? 1 : 0);
