// Printable copy of a signed weekly report (employee's own copy / file copy).
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLOSURE = { no_action: 'Closed — no action needed', action_assigned: 'Closed — corrective action assigned', referred: 'Closed — referred to management' };
const EVENT = {
  clarification_requested: 'Supervisor asked', clarification_withdrawn: 'Supervisor withdrew question',
  employee_response: 'Employee responded', employee_seen: 'Employee marked the review as seen (not agreement)', supervisor_note: 'Supervisor note'
};

// Same heading as the paper form: "Weekly Report <Friday's date> for <name>".
function paperDate(weekStart) {
  const d = new Date(weekStart + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 4);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

export function renderRecordHtml(rec) {
  const o = rec.original.payload;
  const rows = o.answers.map(a => `<tr><td>${esc(a.questionText)}${a.origin === 'paper' ? '' : ' <em>(added item)</em>'}</td><td><strong>${esc(a.answerLabel ?? a.answer)}</strong></td></tr>`).join('');
  const sigLine = (p, h, integ) => `<p class="sig">Signed by ${esc(p.signature.signerName || p.signature.typedName)} at ${esc(p.signedAtLocal)}. Identity: ${esc(p.signature.identity ? p.signature.identity.method + '; ' + p.signature.identity.device : '')}.<br>Record hash (SHA-256) <code>${esc(h)}</code> — ${esc(integ)}</p>`;
  const amend = rec.amendments.map(m => `<section><h3>Correction ${esc(m.id)}</h3><p>${esc(m.payload.note)}</p>
    ${Object.keys(m.payload.corrections || {}).length ? `<p>Corrected answers: ${esc(Object.entries(m.payload.corrections).map(([k, v]) => k + ' → ' + v).join(', '))}</p>` : ''}${sigLine(m.payload, m.hash, m.integrity)}</section>`).join('');
  const events = rec.events.map(e => `<li><strong>${esc(EVENT[e.kind] || e.kind)}</strong> — ${esc(e.by)}, ${esc(e.at)}: ${esc(e.text)}</li>`).join('');
  const reviews = rec.reviews.map(r => `<section><h3>Supervisor sign-off — ${esc(r.payload.reviewer.displayName)}</h3>
    <p>${esc(r.payload.comments) || '<em>No comments</em>'}</p>
    ${r.payload.trainingNeeded ? `<p>Training identified: ${esc(r.payload.trainingNote || 'yes')}</p>` : ''}
    ${r.payload.performanceConcern ? `<p>Performance concern noted: ${esc(r.payload.performanceNote || 'yes')}</p>` : ''}
    <p><strong>${esc(CLOSURE[r.payload.closure] || r.payload.closure)}</strong></p>
    <p class="sig">${esc(r.payload.acknowledgment)}</p>${sigLine(r.payload, r.hash, r.integrity)}</section>`).join('');
  return `<!doctype html><html lang="${esc(o.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Weekly report ${esc(o.reportingPeriod.start)} — ${esc(o.employee.displayName)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#111}
table{width:100%;border-collapse:collapse}td{border-bottom:1px solid #ddd;padding:8px 4px;vertical-align:top}
.demo{background:#fff3cd;border:1px solid #e0b100;padding:8px 12px;border-radius:6px}.sig{color:#333;font-size:12px}code{word-break:break-all;font-size:11px}</style></head><body>
${o.demo ? '<p class="demo"><strong>DEMO RECORD — synthetic data. Not a legally operative signature.</strong></p>' : ''}
<h1>Weekly Report ${esc(paperDate(o.reportingPeriod.start))} for ${esc(o.employee.displayName)}</h1>
<p><strong>${esc(o.employee.displayName)}</strong> (${esc(o.employee.id)}) · Reporting week ${esc(o.reportingPeriod.start)} to ${esc(o.reportingPeriod.end)} (${esc(o.reportingPeriod.timeZone)})</p>
<p>Questionnaire ${esc(o.form.templateId)} — ${esc(o.form.label)} · Submission ${esc(o.submissionId)}${o.late ? ' · <strong>signed after the due time</strong>' : ''}</p>
<table>${rows}</table>
<h2>Employee signature</h2>
<p>${esc(o.signature.statementShown)}</p>
${sigLine(o, rec.original.hash, rec.original.integrity)}
<p class="sig">${esc(o.signature.affirmativeAction)}. E-sign consent ${esc(o.signature.consent.version)} given ${esc(o.signature.consent.at)}.</p>
${amend ? '<h2>Corrections (the original above is unchanged)</h2>' + amend : ''}
${events ? '<h2>Questions, responses and acknowledgments</h2><ul>' + events + '</ul>' : ''}
${reviews ? '<h2>Supervisor review</h2>' + reviews : '<h2>Supervisor review</h2><p>Not reviewed yet.</p>'}
${rec.paperEvents.length ? '<h2>Paper process</h2>' + rec.paperEvents.map(p => `<p>${esc(p.event)} — ${esc(p.created_at)} ${esc(p.note)}</p>`).join('') : ''}
</body></html>`;
}
