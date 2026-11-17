// Regenerates src/app/privacy.ts (the in-app copy) from PRIVACY.md:
//   npx tsx tool/sync-privacy.ts
import { readFileSync, writeFileSync } from 'node:fs';

export const plainPrivacy = (md: string): string => md.replace(/^#+ /gm, '').replace(/\*\*/g, '').trim();

if (process.argv[1]?.endsWith('sync-privacy.ts')) {
  const text = plainPrivacy(readFileSync('PRIVACY.md', 'utf8'));
  writeFileSync('src/app/privacy.ts', `// Generated from PRIVACY.md by tool/sync-privacy.ts — do not edit by hand.\nexport const PRIVACY_TEXT = ${JSON.stringify(text)};\n`);
}
