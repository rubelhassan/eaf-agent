// @ts-check
// Debug reply: {issue: null | {severity, blocks, explanation}, fix: null | {title, ops}, voiceLine}.

// The newest debug prompt (on the server); its checks apply when a reply doesn't say its version.
const LATEST = 'v4';

// Most severe first. v2 and v3 used error | warn | info.
export const SEVERITIES = ['wontRun', 'runtimeError', 'wrongResult', 'fragile'];
const OLD_SEVERITIES = ['error', 'warn', 'info'];
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

export const DEBUG = {
  version: LATEST,
  /** @returns {!Array<string>} */
  shape(o, ws, version = LATEST) {
    const severities = ['v2', 'v3'].includes(version) ? OLD_SEVERITIES : SEVERITIES;
    const problems = [];
    if (!isText(o.voiceLine)) problems.push('voiceLine must be text');
    if (o.issue === null || o.issue === undefined) {
      if (o.fix) problems.push('with no issue, fix must be null');
      return problems;
    }
    if (!severities.includes(o.issue.severity)) problems.push(`issue.severity must be one of ${severities.join(', ')}`);
    if (!isText(o.issue.explanation)) problems.push('issue.explanation must be text');
    if (!Array.isArray(o.issue.blocks) || !o.issue.blocks.length) problems.push('issue.blocks must list the blocks at fault');
    else for (const id of o.issue.blocks) if (!ws.getBlockById(id)) problems.push(`issue.blocks has ${id}, which is not in the program`);
    if (o.fix !== null && o.fix !== undefined && !Array.isArray(o.fix.ops)) problems.push('fix.ops must be a list of ops');
    return problems;
  },
  steps: (o) => (o?.fix ? [o.fix] : []),
  withoutSteps: (o) => ({...o, fix: null}),
  blockRefs: (o) => (Array.isArray(o?.issue?.blocks) ? o.issue.blocks : null),
};
