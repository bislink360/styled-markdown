// Skill files and document templates, bundled into the CLI at build time (esbuild text loader),
// so `smd skills install` and `smd init --template` work from a single self-contained file.
import READER_SKILL from '../../skills/styled-markdown-reader/SKILL.md';
import WRITER_SKILL from '../../skills/styled-markdown-writer/SKILL.md';
import WRITER_SYNTAX from '../../skills/styled-markdown-writer/references/syntax.md';
import WRITER_STYLE from '../../skills/styled-markdown-writer/references/style-guide.md';
import T_PRD from '../../skills/styled-markdown-writer/assets/templates/prd.smd';
import T_ADR from '../../skills/styled-markdown-writer/assets/templates/adr.smd';
import T_RFC from '../../skills/styled-markdown-writer/assets/templates/rfc.smd';
import T_RUNBOOK from '../../skills/styled-markdown-writer/assets/templates/runbook.smd';
import T_API from '../../skills/styled-markdown-writer/assets/templates/api.smd';
import T_STATUS from '../../skills/styled-markdown-writer/assets/templates/status-report.smd';
import T_MEETING from '../../skills/styled-markdown-writer/assets/templates/meeting-notes.smd';
import T_POSTMORTEM from '../../skills/styled-markdown-writer/assets/templates/postmortem.smd';
import T_RELEASE from '../../skills/styled-markdown-writer/assets/templates/release-notes.smd';
import T_OKRS from '../../skills/styled-markdown-writer/assets/templates/okrs.smd';
import T_ONBOARDING from '../../skills/styled-markdown-writer/assets/templates/onboarding.smd';
import T_TEST_PLAN from '../../skills/styled-markdown-writer/assets/templates/test-plan.smd';
import T_PR from '../../skills/styled-markdown-writer/assets/templates/pr-description.smd';

export const TEMPLATES: Record<string, { description: string; text: string }> = {
  prd: { description: 'Product requirements / feature spec', text: T_PRD },
  adr: { description: 'Architecture decision record', text: T_ADR },
  rfc: { description: 'Design proposal / technical spec', text: T_RFC },
  runbook: { description: 'On-call / operational procedure', text: T_RUNBOOK },
  api: { description: 'API reference', text: T_API },
  'status-report': { description: 'Weekly or monthly status update', text: T_STATUS },
  'meeting-notes': { description: 'Meeting summary with decisions and actions', text: T_MEETING },
  postmortem: { description: 'Incident review with timeline, root cause and follow-ups', text: T_POSTMORTEM },
  'release-notes': { description: 'Release highlights, breaking changes and upgrade steps', text: T_RELEASE },
  okrs: { description: 'Objectives and key results for a period', text: T_OKRS },
  onboarding: { description: 'Onboarding guide for new team members', text: T_ONBOARDING },
  'test-plan': { description: 'Test scope, strategy, cases and exit criteria', text: T_TEST_PLAN },
  'pr-description': { description: 'Pull request summary, testing and rollback', text: T_PR },
};

export interface SkillBundle {
  name: string;
  summary: string;
  /** Relative path inside the skill folder → file content. scripts/smd.cjs is added at install time. */
  files: Record<string, string>;
}

export const SKILLS: SkillBundle[] = [
  {
    name: 'styled-markdown-reader',
    summary: 'read .smd token-efficiently (outline → sections → edit)',
    files: { 'SKILL.md': READER_SKILL },
  },
  {
    name: 'styled-markdown-writer',
    summary: 'create and edit .smd following the rules (templates + validator)',
    files: {
      'SKILL.md': WRITER_SKILL,
      'references/syntax.md': WRITER_SYNTAX,
      'references/style-guide.md': WRITER_STYLE,
      ...Object.fromEntries(Object.entries(TEMPLATES).map(([name, t]) => [`assets/templates/${name}.smd`, t.text])),
    },
  },
];

export { fillTemplate } from './core';
