// Signs the command-line tools in with ChatGPT, so the engine lab can use the LLM:
//
//   npm run eval -- signin [--adb]
//
// The engine itself is tested in the lab: see tool/lab/README.md.
import { evalSignIn } from './eval-llm';

const args = process.argv.slice(2);

async function main(): Promise<void> {
  if (args[0] !== 'signin') {
    console.error('usage: npm run eval -- signin [--adb]\nEngine experiments: see tool/lab/README.md');
    process.exit(64);
  }
  await evalSignIn(args.includes('--adb'));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
