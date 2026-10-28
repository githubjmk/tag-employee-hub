// Onboarding emails through Resend (https://resend.com), from the verified domain innerspacecases.com.
// Live Hub only, with the Worker secret RESEND_API_KEY. The test copy never sends email: it keeps
// a preview of what would have been sent.

export function makeResendMailer({ fetch, apiKey, from = 'Innerspace Employee Hub <info@innerspacecases.com>', replyTo = null }) {
  if (!apiKey) return null;
  return {
    live: true,
    async send({ to, subject, html, text }) {
      let r;
      try {
        r = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
          signal: AbortSignal.timeout(10000)
        });
      } catch { return { ok: false, detail: 'network' }; }
      let j = null; try { j = await r.json(); } catch { /* ignore */ }
      return r.status >= 200 && r.status < 300 ? { ok: true, id: j && j.id, detail: 'HTTP ' + r.status } : { ok: false, detail: 'HTTP ' + r.status + (j && j.message ? ': ' + String(j.message).slice(0, 200) : '') };
    }
  };
}

// Test copy / local: nothing leaves the Hub; the last messages are kept for the preview screen.
export function makePreviewMailer() {
  const sent = [];
  return { live: false, sent, async send(m) { sent.unshift({ ...m, at: new Date().toISOString() }); sent.length = Math.min(sent.length, 20); return { ok: true, id: 'preview-' + sent.length, detail: 'preview only (test copy)' }; } };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The welcome email. Plain, bilingual by the person's language, works in every mail app.
export function inviteEmail({ name, link, expiresText, lang = 'en', logoUrl, inviterName, management = false }) {
  const first = String(name || '').split(' ')[0];
  const T = lang === 'es' ? {
    subject: 'Bienvenido al Portal del empleado de Innerspace',
    hi: `Hola ${first},`,
    intro: `${inviterName ? inviterName + ' lo invitó' : 'Lo invitamos'} al Portal del empleado de Innerspace Cases: su reporte semanal, reportes de seguridad y enlaces de la empresa, en su teléfono.`,
    button: 'Configurar mi cuenta',
    steps: ['Toque el botón (en su teléfono).', 'Elija su PIN personal.', management ? 'Agregue el Portal a su app de autenticación (lo guiamos).' : null, 'Siga la guía: ícono en la pantalla de inicio, Face ID o huella, y recordatorios.'].filter(Boolean),
    time: 'Toma unos 3 minutos.',
    expires: `Este enlace funciona una sola vez y vence ${expiresText}. Si vence, pida uno nuevo a la gerencia.`,
    notyou: 'Si no esperaba este correo, ignórelo.',
    paid: 'El reporte semanal se llena en el trabajo, durante tiempo pagado.'
  } : {
    subject: 'Welcome to the Innerspace Employee Hub',
    hi: `Hi ${first},`,
    intro: `${inviterName ? inviterName + ' invited you' : 'You are invited'} to the Innerspace Cases Employee Hub: your weekly report, safety reports and company links, on your phone.`,
    button: 'Set up my account',
    steps: ['Tap the button (on your phone).', 'Choose your personal PIN.', management ? 'Add the Hub to your authenticator app (we walk you through it).' : null, 'Follow the guide: home-screen icon, Face ID or fingerprint, and reminders.'].filter(Boolean),
    time: 'It takes about 3 minutes.',
    expires: `This link works once and expires ${expiresText}. If it expires, ask management for a new one.`,
    notyou: 'If you were not expecting this email, you can ignore it.',
    paid: 'The weekly report is filled in at work, during paid time.'
  };
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1e8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#15171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1e8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #d9d3c4">
<tr><td style="background:#14213d;padding:20px 24px"><img src="${esc(logoUrl)}" alt="Innerspace Cases" width="150" style="display:block;border:0"></td></tr>
<tr><td style="padding:24px">
<p style="font-size:18px;font-weight:700;margin:0 0 10px">${esc(T.hi)}</p>
<p style="font-size:16px;line-height:1.5;margin:0 0 20px">${esc(T.intro)}</p>
<p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#1d4ed8;color:#ffffff;text-decoration:none;font-weight:700;font-size:17px;padding:14px 22px;border-radius:10px">${esc(T.button)}</a></p>
<ol style="font-size:15px;line-height:1.6;padding-left:20px;margin:0 0 12px">${T.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol>
<p style="font-size:14px;color:#4a4f59;margin:0 0 16px">${esc(T.time)} ${esc(T.paid)}</p>
<p style="font-size:13px;color:#4a4f59;margin:0 0 6px">${esc(T.expires)}</p>
<p style="font-size:13px;color:#4a4f59;margin:0">${esc(T.notyou)}</p>
</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid #eee;font-size:12px;color:#4a4f59;text-align:center">© ${new Date().getFullYear()} The Armored Group, Inc. · Innerspace Cases · 11555 Cantara St, North Hollywood, CA</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${T.hi}\n\n${T.intro}\n\n${T.button}: ${link}\n\n${T.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\n${T.time} ${T.paid}\n${T.expires}\n${T.notyou}\n\n© The Armored Group, Inc.`;
  return { subject: T.subject, html, text };
}
