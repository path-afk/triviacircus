'use strict';

const TOPIC_WINDOW = 4;
const CANDIDATE_SCAN_LIMIT = 4;
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from',
  'how', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were',
  'what', 'when', 'where', 'which', 'who', 'with',
]);
const TOKEN_CACHE = new WeakMap();

function topicTokens(question) {
  if (question && typeof question === 'object' && TOKEN_CACHE.has(question)) {
    return TOKEN_CACHE.get(question);
  }
  const value = question.prompt || question.text || '';
  const tokens = new Set(String(value).normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/)
    .filter(token => token && !STOP_WORDS.has(token)));
  if (question && typeof question === 'object') TOKEN_CACHE.set(question, tokens);
  return tokens;
}

function jaccard(left, right) {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
}

function topicPenalty(question, recent) {
  const tokens = topicTokens(question);
  let penalty = 0;
  for (let index = 0; index < recent.length; index += 1) {
    const prior = recent[recent.length - 1 - index];
    const distanceWeight = TOPIC_WINDOW - index;
    let pairPenalty = 0;
    if (question.sourceRecordId && question.sourceRecordId === prior.sourceRecordId) pairPenalty += 100;
    if (question.sourceLabel && question.sourceLabel === prior.sourceLabel) pairPenalty += 40;
    if (question.sourceRecordId || question.transformation
      || prior.sourceRecordId || prior.transformation) {
      const similarity = jaccard(tokens, topicTokens(prior));
      if (similarity >= 0.8) pairPenalty += 30;
      else if (similarity >= 0.6) pairPenalty += 12;
    }
    penalty += pairPenalty * distanceWeight;
  }
  return penalty;
}

function topicPressure(question, recordCounts, transformationCounts) {
  const recordPressure = question.sourceRecordId
    ? Math.min(4, (recordCounts.get(question.sourceRecordId) || 1) - 1) * 20
    : 0;
  const transformationPressure = question.transformation
    ? Math.min(4, (transformationCounts.get(question.transformation) || 1) - 1) * 3
    : 0;
  return recordPressure + transformationPressure;
}

/**
 * Return a randomized question order with category streaks kept as short as
 * the category counts permit. The input array and its question objects are
 * never changed.
 *
 * @param {Array<object>} questions
 * @param {() => number} random A Math.random-compatible function.
 * @returns {Array<object>}
 */
function categoryBalancedShuffle(questions, random = Math.random) {
  if (!Array.isArray(questions)) {
    throw new TypeError('questions must be an array');
  }
  if (typeof random !== 'function') {
    throw new TypeError('random must be a function');
  }
  if (questions.length < 2) return questions.slice();

  const randomUnit = () => {
    const value = Number(random());
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError('random must return a number in [0, 1)');
    }
    return value;
  };

  const shuffle = values => {
    const result = values.slice();
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(randomUnit() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  };

  const byCategory = new Map();
  for (const question of questions) {
    const category = question.category;
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(question);
  }

  // Shuffle both levels independently: item order inside a category and the
  // category iteration order used by weighted random selection.
  let groups = [...byCategory.entries()].map(([category, items]) => ({
    category,
    items: shuffle(items),
  }));
  groups = shuffle(groups);

  const recordCounts = new Map();
  const transformationCounts = new Map();
  for (const question of questions) {
    if (question.sourceRecordId) {
      recordCounts.set(question.sourceRecordId, (recordCounts.get(question.sourceRecordId) || 0) + 1);
    }
    if (question.transformation) {
      transformationCounts.set(question.transformation,
        (transformationCounts.get(question.transformation) || 0) + 1);
    }
  }

  const total = questions.length;
  let runLimit = 1;
  for (const group of groups) {
    const count = group.items.length;
    runLimit = Math.max(runLimit, Math.ceil(count / (total - count + 1)));
  }

  const result = [];
  let lastGroup = null;
  let currentRun = 0;
  let remainingTotal = total;

  // Check whether choosing a group still permits every remaining category to
  // fit under the mathematically minimal run limit. For the category just
  // chosen, the partially filled trailing run reduces its first available gap.
  const remainsCompletable = candidate => {
    const nextRun = candidate === lastGroup ? currentRun + 1 : 1;
    if (nextRun > runLimit) return false;

    const afterTotal = remainingTotal - 1;
    for (const group of groups) {
      const count = group.items.length - (group === candidate ? 1 : 0);
      if (count === 0) continue;
      const otherCount = afterTotal - count;
      const capacity = runLimit * (otherCount + 1)
        - (group === candidate ? nextRun : 0);
      if (count > capacity) return false;
    }
    return true;
  };

  const weightedChoice = candidates => {
    const weight = candidates.reduce((sum, group) => sum + group.items.length, 0);
    let target = randomUnit() * weight;
    for (const group of candidates) {
      target -= group.items.length;
      if (target < 0) return group;
    }
    return candidates[candidates.length - 1];
  };

  const bestCandidateIndexes = (group, recent) => {
    const indexes = [];
    let bestScore = Infinity;
    const first = Math.max(0, group.items.length - CANDIDATE_SCAN_LIMIT);
    for (let index = first; index < group.items.length; index += 1) {
      const penalty = topicPenalty(group.items[index], recent);
      const pressure = topicPressure(group.items[index], recordCounts, transformationCounts);
      const score = penalty - pressure * 14;
      if (score < bestScore) {
        bestScore = score;
        indexes.length = 0;
        indexes.push(index);
      } else if (score === bestScore) {
        indexes.push(index);
      }
    }
    return { indexes, score: bestScore };
  };

  while (remainingTotal > 0) {
    const feasible = groups.filter(group =>
      group.items.length > 0 && remainsCompletable(group));
    if (feasible.length === 0) {
      throw new Error('unable to construct a category-balanced order');
    }

    // Avoid adjacency whenever doing so does not sacrifice the optimal global
    // run limit. A repeat is selected only when it is needed to prevent a
    // longer, avoidable streak later in a skewed data set.
    const alternatives = feasible.filter(group => group !== lastGroup);
    const categoryPool = alternatives.length > 0 ? alternatives : feasible;
    const recent = result.slice(-TOPIC_WINDOW);
    const ranked = categoryPool.map(group => ({
      group,
      ...bestCandidateIndexes(group, recent),
    }));
    const minimumScore = Math.min(...ranked.map(entry => entry.score));
    const bestGroups = ranked.filter(entry => entry.score === minimumScore);
    const chosen = weightedChoice(bestGroups.map(entry => entry.group));
    const selected = bestGroups.find(entry => entry.group === chosen);
    const candidateIndex = selected.indexes[Math.floor(randomUnit() * selected.indexes.length)];
    const [question] = chosen.items.splice(candidateIndex, 1);
    if (question.sourceRecordId) {
      recordCounts.set(question.sourceRecordId, recordCounts.get(question.sourceRecordId) - 1);
    }
    if (question.transformation) {
      transformationCounts.set(question.transformation,
        transformationCounts.get(question.transformation) - 1);
    }

    result.push(question);
    currentRun = chosen === lastGroup ? currentRun + 1 : 1;
    lastGroup = chosen;
    remainingTotal -= 1;
  }

  return result;
}

module.exports = { categoryBalancedShuffle };
