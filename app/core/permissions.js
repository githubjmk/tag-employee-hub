// R1.2 permission framework.
//
// People see exactly two roles: Staff and Management. Internally an account
// carries a small set of capability roles, and every server check is written
// against those (see PERMISSIONS below for the full map). New capabilities can
// be added later without changing what people see.
//
//   Staff                         -> employee
//   Management                    -> employee, supervisor, manager
//     + "Full access" option      -> + hr      (every survey, employee accounts)
//     + "Safety contact" option   -> + safety  (receives urgent safety alerts and escalations,
//                                               sees confidential reporters' names)

export const VISIBLE_ROLES = ['staff', 'management'];
export const INTERNAL_ROLES = ['employee', 'supervisor', 'manager', 'safety', 'hr'];
export const MANAGEMENT_ROLES = ['supervisor', 'manager', 'safety', 'hr'];

export function internalRolesFor({ role, fullAccess = false, safetyContact = false } = {}) {
  if (role === 'staff') return ['employee'];
  if (role !== 'management') throw new Error('Unknown role');
  const r = ['employee', 'supervisor', 'manager'];
  if (safetyContact) r.push('safety');
  if (fullAccess) r.push('hr');
  return r;
}

export function describeRoles(roles) {
  const management = roles.some(r => MANAGEMENT_ROLES.includes(r));
  return { role: management ? 'management' : 'staff', fullAccess: roles.includes('hr'), safetyContact: roles.includes('safety') };
}

// Permission -> internal roles that hold it. This table documents what the
// service enforces; session.me returns the caller's permissions so the UI can
// show only what the server would allow anyway.
export const PERMISSIONS = {
  'survey.complete': ['employee'],
  'records.own': ['employee'],
  'safety.report': ['employee'],
  'survey.review.team': ['supervisor'],          // direct reports only
  'survey.review.all': ['hr'],
  'survey.status.all': ['manager', 'hr'],
  'dashboard.view': ['supervisor', 'manager', 'safety', 'hr'],
  'safety.manage': ['manager', 'safety', 'hr'],
  'safety.identity.confidential': ['safety', 'hr'],
  'safety.escalation.contact': ['safety'],
  'actions.manage': ['supervisor', 'manager', 'safety', 'hr'],
  'accounts.pinReset.team': ['supervisor'],      // staff who report to them
  'accounts.manage': ['hr'],                     // create, edit, deactivate, reset any PIN, reset MFA
  'accounts.list.team': ['supervisor'],          // see accounts of people who report to them
  'people.list': ['supervisor', 'manager', 'safety', 'hr'],
  'absence.record.team': ['supervisor'],
  'absence.record.all': ['hr'],
  'missing.excuse.team': ['supervisor'],         // excuse a week / record the paper process for own team
  'missing.excuse.all': ['manager', 'hr'],
  'devices.manage': ['manager', 'hr'],           // optional shop-tablet registration
  'admin.delivery': ['manager', 'safety', 'hr'],
  'admin.integrity': ['manager', 'hr'],
  'admin.restore': ['hr'],
  'admin.backup': ['hr']                         // full backup download (contains confidential reports)                        // point-in-time restore: full-access management only
};

export const permissionsOf = (roles) => Object.keys(PERMISSIONS).filter(p => PERMISSIONS[p].some(r => roles.includes(r)));
