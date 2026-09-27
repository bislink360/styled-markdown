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

export const TEMPLATES: Record<string, { description: string; text: string }> = {
  prd: { description: 'Product requirements / feature spec', text: T_PRD },
  adr: { description: 'Architecture decision record', text: T_ADR },
  rfc: { description: 'Design proposal / technical spec', text: T_RFC },
  runbook: { description: 'On-call / operational procedure', text: T_RUNBOOK },
  api: { description: 'API reference', text: T_API },
  'status-report': { description: 'Weekly or monthly status update', text: T_STATUS },
  'meeting-notes': { description: 'Meeting summary with decisions and actions', text: T_MEETING },
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
