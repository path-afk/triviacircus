#!/usr/bin/env node
'use strict';

const path = require('node:path');
const {
  importOpenTriviaDirectory,
  writeOfflineCache,
} = require('./importer');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value argument, received ${flag || '<empty>'}`);
    }
    options[flag.slice(2)] = value;
  }
  if (!options.input) throw new Error('--input is required');
  return options;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const modifiedAt = args['modified-at'] || new Date().toISOString();
  if (Number.isNaN(Date.parse(modifiedAt))) throw new Error('--modified-at must be an ISO timestamp');
  const outputPath = path.resolve(args.output || 'cache/open-trivia-qa.json');
  const rejectionPath = path.resolve(args.rejections || 'cache/open-trivia-qa-rejections.json');
  const revision = args.revision || 'master';
  const result = await importOpenTriviaDirectory(path.resolve(args.input), {
    modifiedAt,
    revision,
    shuffleSeed: args['shuffle-seed'],
  });
  await writeOfflineCache(outputPath, rejectionPath, result, {
    generatedAt: modifiedAt,
    revision,
  });
  process.stdout.write(`${JSON.stringify(result.stats, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`Import failed: ${error.message}\n`);
  process.exitCode = 1;
});
