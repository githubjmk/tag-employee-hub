// Weekly Report questionnaire versions.
//
// Source of the original: Drive "Weekly Report.docx" (master template, last
// modified 2023-08-23; identical text in the 2016-11-11 copy) and the printed
// forms of 2014-02-21 and 2022-08-19. Text below is transcribed VERBATIM,
// including spelling and grammar errors, so the archive is faithful.
//
//   WR-PAPER   archived   exact paper wording; never assigned
//   WR-1.0     active     paper questions 1-4 verbatim + three optional items
//                         requested in the R1.1 brief; one intro sentence
//                         withheld pending legal review (gate G1)
//   WR-2.0-P   proposed   revised wording; preview only, cannot be assigned
//                         until management approves (config.activeTemplate)

const RATING = [
  { value: 5, en: 'Superior', es: 'Superior' },
  { value: 4, en: 'Excellent', es: 'Excelente' },
  { value: 3, en: 'Good', es: 'Bien' },
  { value: 2, en: 'Fair', es: 'Regular' },
  { value: 1, en: 'Poor', es: 'Malo' }
];
const YESNO = [
  { value: 'yes', en: 'Yes', es: 'Si' },
  { value: 'no', en: 'No', es: 'No' }
];

const PAPER_INTRO = {
  en: 'Please complete the following survey in order to assist the company with our compliance of safety and regulatory practices. This survey is mandatory for ALL employees and will be required prior to returning to work on Monday morning. If you do not understand something please ask.',
  es: 'Por favor complete la siguiente encuesta con el fin de ayudar a la empresa con nuestro cumplimiento de las prácticas de seguridad y reglamentarias. Esta encuesta es obligatoria para todos los empleados y se requiere antes de volver al trabajo el lunes por la mañana. Si no entiende algo, por favor preguntar.'
};
const PAPER_Q = {
  q1: { en: 'Please rate your productivity this week:', es: 'Por favor, califique su productividad esta semana:' },
  q2: { en: 'Please rate your compliance with our safety rules:', es: 'Por favor, califique el cumplimiento de nuestras reglas de seguridad:' },
  q3: { en: 'Did you report any safety issues to management this week?', es: '¿Sabía usted reporta cualquier problema de seguridad para la gestión de esta semana?' },
  q4: { en: 'Have you suffered any injury at work or outside or work?', es: '¿Ha sufrido alguna lesión en el trabajo o en el exterior o en el trabajo?' }
};

export const WR_PAPER = {
  id: 'WR-PAPER', status: 'archived', label: 'Original paper form (archived)',
  source: 'Drive: Weekly Report.docx (master, modified 2023-08-23); printed copies 2014-02-21, 2016-11-11, 2022-08-19',
  header: { en: 'Weekly Report [date] for [employee name]', es: null },
  intro: PAPER_INTRO,
  instruction: { en: 'Circle Your Answers Please', es: 'Marcar su respuestas por favor' },
  sections: [{ id: 'all', title: { en: 'Weekly Report', es: 'Weekly Report' }, questions: [
    { id: 'q1', type: 'rating', required: true, origin: 'paper', text: PAPER_Q.q1, options: RATING },
    { id: 'q2', type: 'rating', required: true, origin: 'paper', text: PAPER_Q.q2, options: RATING },
    { id: 'q3', type: 'yesno', required: true, origin: 'paper', text: PAPER_Q.q3, options: YESNO },
    { id: 'q4', type: 'yesno', required: true, origin: 'paper', text: PAPER_Q.q4, options: YESNO }
  ] }],
  signature: { method: 'wet ink', labels: { en: 'Employee Signature / Date', es: 'Firma del empleado / Fecha' }, statement: null },
  supervisorSignature: false
};

const SIGNATURE_STATEMENT = {
  en: 'By checking this box, entering my PIN and tapping Sign & submit, I am electronically signing this weekly report. My signature means these are my own answers, to the best of my knowledge, for the reporting week shown. It does not mean I agree with any supervisor comments, and it does not waive any of my rights.',
  es: 'Al marcar esta casilla, ingresar mi PIN y tocar Firmar y enviar, estoy firmando electrónicamente este reporte semanal. Mi firma significa que estas son mis propias respuestas, según mi conocimiento, para la semana indicada. No significa que estoy de acuerdo con comentarios del supervisor y no renuncio a ninguno de mis derechos.'
};
// R1.3: the same statement when the person approves with Face ID / fingerprint on their own phone
// instead of typing the PIN. Only the method words differ; the meaning of the signature is identical.
const SIGNATURE_STATEMENT_PASSKEY = {
  en: 'By checking this box, approving with Face ID, fingerprint or my phone\'s passcode and tapping Sign, I am electronically signing this weekly report. My signature means these are my own answers, to the best of my knowledge, for the reporting week shown. It does not mean I agree with any supervisor comments, and it does not waive any of my rights.',
  es: 'Al marcar esta casilla, aprobar con Face ID, huella o el código de mi teléfono y tocar Firmar, estoy firmando electrónicamente este reporte semanal. Mi firma significa que estas son mis propias respuestas, según mi conocimiento, para la semana indicada. No significa que estoy de acuerdo con comentarios del supervisor y no renuncio a ninguno de mis derechos.'
};

// Optional items the R1.1 brief asks the workflow to support (comments, safety
// issues, work obstacles). Wording is a draft for approval.
const SUPPLEMENTAL = [
  { id: 's1', type: 'text', required: false, origin: 'supplemental', maxLength: 1500, flags: ['safety-concern'],
    text: { en: 'Did you notice anything unsafe this week? (optional)', es: '¿Notó algo inseguro esta semana? (opcional)' },
    help: { en: 'This creates a safety report right away. If someone could get hurt now, tell your supervisor in person first.', es: 'Esto crea un reporte de seguridad de inmediato. Si alguien puede lastimarse ahora, avise primero a su supervisor en persona.' } },
  { id: 's2', type: 'text', required: false, origin: 'supplemental', maxLength: 1500, flags: ['work-obstacle'],
    text: { en: 'Did anything slow down your work this week, like tools, machines, materials or drawings? (optional)', es: '¿Algo hizo más lento su trabajo esta semana, como herramientas, máquinas, materiales o dibujos? (opcional)' } },
  { id: 's3', type: 'text', required: false, origin: 'supplemental', maxLength: 2000,
    text: { en: 'Other comments (optional)', es: 'Otros comentarios (opcional)' } }
];

export const WR_1_0 = {
  id: 'WR-1.0', status: 'active', label: 'Digital v1.0 — paper questions verbatim',
  source: 'Questions 1–4 verbatim from WR-PAPER',
  intro: {
    en: 'Please complete the following survey in order to assist the company with our compliance of safety and regulatory practices. If you do not understand something please ask.',
    es: 'Por favor complete la siguiente encuesta con el fin de ayudar a la empresa con nuestro cumplimiento de las prácticas de seguridad y reglamentarias. Si no entiende algo, por favor preguntar.'
  },
  withheld: [{
    gate: 'G1',
    text: { en: 'This survey is mandatory for ALL employees and will be required prior to returning to work on Monday morning.', es: 'Esta encuesta es obligatoria para todos los empleados y se requiere antes de volver al trabajo el lunes por la mañana.' },
    reason: 'Implies completing the survey off the clock (Wage Order 1, hours worked). Withheld from display until management decides with counsel. Not replaced with new wording.'
  }],
  paidTimeNotice: {
    en: 'Complete this at work, during paid time. If you are off the clock, stop and finish it at your next shift.',
    es: 'Complete esto en el trabajo, durante tiempo pagado. Si no está trabajando, deténgase y termínelo en su próximo turno.'
  },
  sections: [
    { id: 'performance', title: { en: 'Performance', es: 'Desempeño' }, questions: [
      { id: 'q1', type: 'rating', required: true, origin: 'paper', text: PAPER_Q.q1, options: RATING }
    ] },
    { id: 'safety', title: { en: 'Safety', es: 'Seguridad' }, questions: [
      { id: 'q2', type: 'rating', required: true, origin: 'paper', text: PAPER_Q.q2, options: RATING },
      { id: 'q3', type: 'yesno', required: true, origin: 'paper', text: PAPER_Q.q3, options: YESNO },
      { id: 'q4', type: 'yesno', required: true, origin: 'paper', flags: ['injury-followup', 'legal-gate-G2'], text: PAPER_Q.q4, options: YESNO }
    ] },
    { id: 'notes', title: { en: 'Safety, obstacles & comments', es: 'Seguridad, obstáculos y comentarios' }, questions: SUPPLEMENTAL }
  ],
  signature: { method: 'session + acknowledgment + PIN re-entry (or passkey on own phone)', statement: SIGNATURE_STATEMENT, statementPasskey: SIGNATURE_STATEMENT_PASSKEY },
  supervisorSignature: true
};

export const WR_2_0_PROPOSED = {
  id: 'WR-2.0-P', status: 'proposed', label: 'Proposed v2.0 — needs management approval and counsel review',
  source: 'Revision of WR-1.0; Spanish is a draft for professional translation',
  intro: {
    en: 'This weekly check-in helps us keep the shop safe and catch problems early. Complete it during your shift on Friday — it is paid work time. If anything is unclear, ask your supervisor.',
    es: 'Este reporte semanal nos ayuda a mantener el taller seguro y detectar problemas a tiempo. Complételo durante su turno del viernes; es tiempo de trabajo pagado. Si algo no está claro, pregunte a su supervisor.'
  },
  sections: [
    { id: 'performance', title: { en: 'Performance', es: 'Desempeño' }, questions: [
      { id: 'q1', type: 'rating', required: true, origin: 'revised', text: { en: 'How would you rate your productivity this week?', es: '¿Cómo calificaría su productividad esta semana?' }, options: RATING },
      { id: 'q1b', type: 'text', required: false, origin: 'new', maxLength: 1500, text: { en: 'What got in the way of your work this week, if anything? (optional)', es: '¿Qué le impidió trabajar mejor esta semana, si hubo algo? (opcional)' } }
    ] },
    { id: 'safety', title: { en: 'Safety', es: 'Seguridad' }, questions: [
      { id: 'q2', type: 'rating', required: true, origin: 'revised', text: { en: 'How well did you follow our safety rules this week?', es: '¿Qué tan bien siguió nuestras reglas de seguridad esta semana?' }, options: RATING },
      { id: 'q3', type: 'yesno', required: true, origin: 'revised', text: { en: 'Did you report any safety issues to your supervisor or management this week?', es: '¿Reportó algún problema de seguridad a su supervisor o a la gerencia esta semana?' }, options: YESNO },
      { id: 'q4', type: 'yesno', required: true, origin: 'replaced', flags: ['injury-followup'],
        text: { en: 'Did you have a work-related injury, near miss or unsafe situation this week that you have not reported yet?', es: '¿Tuvo esta semana una lesión relacionada con el trabajo, un casi accidente o una situación insegura que todavía no ha reportado?' }, options: YESNO },
      SUPPLEMENTAL[0]
    ] },
    { id: 'notes', title: { en: 'Comments', es: 'Comentarios' }, questions: [SUPPLEMENTAL[2]] }
  ],
  signature: { method: 'session + acknowledgment + PIN re-entry (or passkey on own phone)', statement: SIGNATURE_STATEMENT, statementPasskey: SIGNATURE_STATEMENT_PASSKEY },
  supervisorSignature: true
};

export const TEMPLATES = { [WR_PAPER.id]: WR_PAPER, [WR_1_0.id]: WR_1_0, [WR_2_0_PROPOSED.id]: WR_2_0_PROPOSED };
export const ASSIGNABLE = new Set(['WR-1.0']);   // WR-2.0-P becomes assignable only after written approval

export const SUPERVISOR_ACK = {
  en: 'I reviewed this weekly report. My comments are my own. I have not changed the employee\'s answers or signed for the employee.',
  es: 'Revisé este reporte semanal. Mis comentarios son míos. No cambié las respuestas del empleado ni firmé por el empleado.'
};
export const SEEN_STATEMENT = {
  en: 'I have seen my supervisor\'s review. This does not mean I agree with it.',
  es: 'He visto la revisión de mi supervisor. Esto no significa que estoy de acuerdo.'
};
export const ESIGN_CONSENT_V1 = {
  version: 'esign-consent-2',   // R1.2: wording says "manager"; shown inside the first signature
  text: {
    en: 'You may sign weekly reports electronically. You can ask for a paper copy of anything you sign, free, at any time, and you can choose paper instead of electronic signing by telling your manager. Choosing paper will not affect your job.',
    es: 'Puede firmar reportes semanales electrónicamente. Puede pedir una copia en papel de cualquier cosa que firme, gratis, en cualquier momento, y puede elegir papel en lugar de firma electrónica diciéndole a su gerente. Elegir papel no afectará su trabajo.'
  }
};

export function getTemplate(id) {
  const t = TEMPLATES[id];
  if (!t) throw new Error('Unknown template ' + id);
  return t;
}
export const allQuestions = (t) => t.sections.flatMap(s => s.questions);
