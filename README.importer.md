# Trivia Circus question importer

This component turns the licensed [OpenTriviaQA](https://github.com/uberspot/OpenTriviaQA) corpus into a normalized, offline JSON cache. It does not include manually authored trivia.

## Normalized record

Every accepted question has exactly these fields:

- `id`: stable source locator (`otqa:<source-file>:L<question-line>`)
- `prompt`, `choices`, `correctIndex`
- `category`, `difficulty`
- `source`, `sourceUrl`, `license`, `attribution`, `modifiedAt`
- `qualityStatus`

The importer decodes mixed UTF-8/Windows-1252 source bytes without introducing replacement characters, strips HTML tags and script/style content, decodes numeric and common named HTML entities, validates answers and choices, rejects malformed or ambiguous records, deduplicates normalized prompts, maps source category names, and preserves source/license attribution per question. Source choice order is preserved unless `--shuffle-seed` is supplied; a given seed and source record always produce the same order.

## Run tests

Requires Node.js 18 or newer and has no importer runtime dependencies.

```sh
npm test
```

The test source contains 9 question blocks, within the intentionally small 6–12 fixture budget.

## Refresh the offline cache

```sh
git clone --depth 1 https://github.com/uberspot/OpenTriviaQA.git .source/OpenTriviaQA
REVISION=$(git -C .source/OpenTriviaQA rev-parse HEAD)
MODIFIED_AT=$(git -C .source/OpenTriviaQA show -s --format=%cI HEAD)
npm run import:open-trivia -- \
  --input .source/OpenTriviaQA/categories \
  --output cache/open-trivia-qa.json \
  --rejections cache/open-trivia-qa-rejections.json \
  --revision "$REVISION" \
  --modified-at "$MODIFIED_AT"
```

Add `--shuffle-seed trivia-circus-v1` only when shuffled choices are desired. Without it, source ordering is retained. The CLI writes both files atomically and prints JSON statistics for imported, rejected, deduplicated, rejection reasons, and accepted questions by category.

`cache/open-trivia-qa.json` is the local offline runtime cache. `cache/open-trivia-qa-rejections.json` is an audit report; rejected records never enter the cache.

## License and attribution

OpenTriviaQA is licensed under **Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)**. The upstream license is reproduced in [`LICENSE.open-triviaqa`](LICENSE.open-triviaqa). Each normalized record carries the license, attribution, source repository, and a revision-pinned source line URL.

Attribution: **OpenTriviaQA contributors; normalized by Trivia Circus.** Normalization includes HTML sanitization, category mapping, validation, deduplication, and optional deterministic choice shuffling. Distributions or adaptations of the imported question data must retain attribution and comply with CC BY-SA 4.0, including ShareAlike where applicable.

The importer code is separate from the imported dataset. No noncommercial-only trivia sources are used.
