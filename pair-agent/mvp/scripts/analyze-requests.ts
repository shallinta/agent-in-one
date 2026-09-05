import { runRequestAnalysis } from './request-analysis-cli.js';

try {
  process.stdout.write(await runRequestAnalysis(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
